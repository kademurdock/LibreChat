'use strict';
/* node --test api/server/services/kadeLibraryFiles.nodetest.js
 * The one-file rule's storage side, on fakes (Sep 25 2026): bytes are hashed as they stream, a stored
 * object goes only when no row lists it, new bytes go only after the stored copy is proven, and a
 * copy the uploader cannot open is linked in silence. */
const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const { Readable, pipeline } = require('node:stream');
const F = require('./kadeLibraryFiles');

const H = (s) => createHash('sha256').update(s).digest('hex');
const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const setPath = (o, path, value) => {
  const parts = path.split('.');
  let cur = o;
  for (const p of parts.slice(0, -1)) cur = cur[p] = cur[p] ?? {};
  cur[parts[parts.length - 1]] = value;
};
/* Just enough of a Mongo matcher for the queries kadeLibraryFiles.js makes. */
function matches(row, q) {
  return Object.entries(q).every(([k, v]) => {
    if (k === '$or') return v.some((sub) => matches(row, sub));
    if (k === 'tracks.key') return (row.tracks || []).some((t) => t.key === v);
    if (k === 'tracks.bytes') return (row.tracks || []).some((t) => t.bytes === v);
    if (k === 'tracks' && v.$elemMatch) return (row.tracks || []).some((t) => matches(t, v.$elemMatch));
    if (/^tracks\.\d+\.key$/.test(k)) return get(row, k) === v;
    if (v && typeof v === 'object' && '$regex' in v) return new RegExp(v.$regex).test(String(get(row, k) || ''));
    if (v && typeof v === 'object' && '$nin' in v) return !v.$nin.map(String).includes(String(get(row, k)));
    if (v && typeof v === 'object' && '$ne' in v) return String(get(row, k)) !== String(v.$ne);
    return String(get(row, k)) === String(v);
  });
}
function fakeBooks(rows) {
  const calls = [];
  const lean = (value) => ({ lean: async () => value, limit() { return this; }, sort() { return this; } });
  const Model = {
    rows,
    calls,
    exists: async (q) => (rows.some((r) => matches(r, q)) ? { _id: 1 } : null),
    find: (q) => { const found = rows.filter((r) => matches(r, q)); const chain = { limit: () => chain, sort: () => chain, lean: async () => found.map((r) => structuredClone(r)) }; return chain; },
    findOne: (q) => lean(rows.find((r) => matches(r, q)) || null),
    findById: (id) => lean(rows.find((r) => String(r._id) === String(id)) || null),
    updateOne: async (filter, update) => {
      calls.push(['updateOne', filter, update]);
      const row = rows.find((r) => matches(r, filter));
      if (!row) return { modifiedCount: 0 };
      for (const [k, v] of Object.entries(update.$set || {})) setPath(row, k, v);
      return { modifiedCount: 1 };
    },
    updateMany: async (filter, update) => { calls.push(['updateMany', filter, update]); return { modifiedCount: 0 }; },
    deleteOne: async () => ({ deletedCount: 1 }),
  };
  return Model;
}
const empty = () => ({ find: () => ({ lean: async () => [] }), findOne: () => ({ lean: async () => null }), updateOne: async () => ({}), deleteOne: async () => ({}), create: async () => ({}) });
function harness(rows, { headOk = true } = {}) {
  const KadeBook = fakeBooks(rows);
  const deleted = [];
  const told = [];
  const sent = [];
  const files = F.createLibraryFiles({
    models: { KadeBook, KadeBookText: empty(), KadeReadingProgress: empty(), KadeReadingBookmark: empty(), KadeCollection: empty(), KadeLibrarySubmission: empty() },
    s3: () => ({ send: async (cmd) => { sent.push(cmd.constructor.name); if (!headOk) throw new Error('NotFound'); return {}; } }),
    bucket: () => 'bucket',
    deleteKeys: async (keys) => { deleted.push(...keys); },
    readerOf: async (id) => ({ id: String(id), admin: false, child: false, hidden: false }),
    notify: (owner, text) => told.push([owner, text]),
    keyFromFileUrl: (url) => { const i = String(url || '').indexOf('/books/'); return i === -1 ? '' : String(url).slice(i + 1).split('?')[0]; },
  });
  return { files, KadeBook, deleted, told, sent };
}
const KADE = 'kade';
const AMBER = 'amber';
const SHA = H('the same tape');

test('a stream is hashed as it flows, byte for byte', async () => {
  const body = Readable.from([Buffer.from('the same '), Buffer.from('tape')]);
  assert.deepStrictEqual(await F.sha256OfStream(body), { sha256: SHA, bytes: 13 });
  const hasher = F.hashingStream();
  const out = [];
  await new Promise((resolve, reject) => pipeline(Readable.from([Buffer.from('the same tape')]), hasher, new (require('node:stream').Writable)({ write(c, _e, done) { out.push(c); done(); } }), (e) => (e ? reject(e) : resolve())));
  assert.deepStrictEqual(hasher.result(), { sha256: SHA, bytes: 13 });
  assert.strictEqual(Buffer.concat(out).toString(), 'the same tape', 'the bytes pass through unchanged');
});

test('a stored object goes only when no other row lists it, as a track or as a book original', async () => {
  const { files, deleted } = harness([
    { _id: 'a', state: 'ready', tracks: [{ key: 'media-library/a/1.mp3' }] },
    { _id: 'b', state: 'ready', tracks: [{ key: 'media-library/a/1.mp3' }] },
    { _id: 'c', state: 'ready', tracks: [], fileKey: 'books/u/book-1.zip' },
  ]);
  assert.deepStrictEqual(await files.releaseKeys(['media-library/a/1.mp3'], { except: ['a'] }), [], 'row b still plays it');
  assert.deepStrictEqual(await files.releaseKeys(['books/u/book-1.zip'], { except: ['x'] }), [], 'row c still reads it');
  assert.deepStrictEqual(await files.releaseKeys(['media-library/a/1.mp3'], { except: ['a', 'b'] }), ['media-library/a/1.mp3']);
  assert.deepStrictEqual(deleted, ['media-library/a/1.mp3']);
});

test('a book original an older row names only in fileUrl is still counted: withdrawing a shortcut to it deletes nothing', async () => {
  const { files, deleted } = harness([
    { _id: 'old', state: 'ready', kind: 'text', tracks: [], fileUrl: 'https://b2.invalid/file/bucket/books/u1/book-abc.zip' },
    { _id: 'signed', state: 'ready', kind: 'text', tracks: [], fileUrl: 'https://b2.invalid/file/bucket/books/u2/book-x.zip?X-Amz-Signature=1' },
  ]);
  assert.deepStrictEqual(await files.releaseKeys(['books/u1/book-abc.zip'], { except: ['the-shortcut'] }), [], 'the original row still reads it');
  assert.deepStrictEqual(await files.releaseKeys(['books/u2/book-x.zip'], { except: ['s'] }), [], 'a presigned URL too');
  assert.deepStrictEqual(await files.releaseKeys(['books/u1/book-ab.zip'], { except: [] }), ['books/u1/book-ab.zip'], 'only the whole name matches');
  assert.deepStrictEqual(await files.releaseKeys(['books/u1/book-abc.zip'], { except: ['old'] }), ['books/u1/book-abc.zip'], 'withdrawing the book itself lets it go');
  assert.deepStrictEqual(deleted, ['books/u1/book-ab.zip', 'books/u1/book-abc.zip']);
});

test("the admin's override never makes someone else's private copy count as one she can open", async () => {
  const privateTwin = { _id: 'p', owner: AMBER, state: 'ready', shared: false, title: "Grandma's Christmas 1994", tracks: [{ key: 'media-library/p/tape.mp3', bytes: 13, sha256: SHA }] };
  const { files } = harness([privateTwin]);
  const found = await files.storedTwin({ id: KADE, admin: true, child: false, hidden: false }, SHA, 13);
  assert.strictEqual(found.twin._id, 'p');
  assert.strictEqual(found.canOpen, false, 'a silent link, never "Already in the library"');
});

test('a merge-made shortcut to a grown-ups file is grown-ups too', async () => {
  const twin = { _id: 'k', owner: KADE, state: 'ready', shared: true, grownUpsOnly: true, title: 'Late show', path: 'Video/Comedy/Specials', tracks: [{ key: 'media-library/k/old.mp4', bytes: 13, sha256: SHA }] };
  const fresh = { _id: 'n', owner: KADE, state: 'ready', shared: true, grownUpsOnly: false, title: 'Late show', path: 'Video/TV/HBO', tracks: [{ key: 'media-library/n/new.mp4', bytes: 13, sha256: SHA }] };
  const { files, KadeBook } = harness([twin, fresh]);
  const r = await files.settleNewCopy(structuredClone(fresh), 0, twin, true);
  assert.strictEqual(r.action, 'shortcut');
  const row = KadeBook.rows.find((x) => x._id === 'n');
  assert.strictEqual(row.shortcutOf, 'k');
  assert.strictEqual(row.grownUpsOnly, true, 'rule 8: never more open than its file');
});

test("a shortcut to a file that was taken down never plays its own old copy of the tracks", async () => {
  const file = { _id: 'k', owner: 'holly', state: 'pending', shared: false, kind: 'audio', tracks: [] };
  const shortcut = { _id: 's', owner: AMBER, state: 'ready', shared: false, title: 'Home video', shortcutOf: 'k', tracks: [{ key: 'media-library/k/a.mp4', bytes: 9 }] };
  const { files } = harness([file, shortcut]);
  assert.strictEqual(await files.withFile(shortcut, { id: AMBER, admin: false, child: false, hidden: false }), null, 'the last part was removed');
  const { files: gone } = harness([shortcut]);
  assert.strictEqual(await gone.withFile(shortcut, { id: AMBER, admin: false, child: false, hidden: false }), null, 'the file row is gone');
});

test('a stalled read is given up, and every byte read counts against the day even when the read fails', async () => {
  const saved = process.env.KADE_LIBRARY_FILES_STALL_S;
  process.env.KADE_LIBRARY_FILES_STALL_S = '0.05';
  try {
    let aborted = 0;
    const stall = { async *[Symbol.asyncIterator]() { yield Buffer.alloc(1000); await new Promise(() => {}); } };
    const drop = { async *[Symbol.asyncIterator]() { yield Buffer.alloc(3000); throw new Error('connection reset'); } };
    const bodies = { stall, drop };
    const files = F.createLibraryFiles({
      models: { KadeBook: fakeBooks([]) },
      s3: () => ({ send: async (cmd, opts) => { if (opts && opts.abortSignal) opts.abortSignal.addEventListener('abort', () => aborted++); if (cmd.input.Key === 'silent') return new Promise(() => {}); return { Body: bodies[cmd.input.Key], ETag: '"x"' }; } }),
      bucket: () => 'bucket', deleteKeys: async () => {}, readerOf: async () => null,
    });
    await assert.rejects(files.sha256Of('silent'), /storage sent nothing/, 'no answer at all');
    await assert.rejects(files.sha256Of('stall'), /storage sent nothing/, 'an answer that stops sending');
    await assert.rejects(files.sha256Of('drop'), /connection reset/);
    assert.strictEqual(files.budget().bytesRead, 4000, 'the partial reads count');
    assert.ok(aborted >= 2, 'the stalled requests are aborted');
  } finally {
    if (saved === undefined) delete process.env.KADE_LIBRARY_FILES_STALL_S; else process.env.KADE_LIBRARY_FILES_STALL_S = saved;
  }
});

test('a new copy Kade can open folds into the stored one, and the new bytes go only after the stored copy answers', async () => {
  const twin = { _id: 'k', owner: KADE, state: 'ready', shared: true, title: 'Dreams and Nightmares', path: 'Audio/Described Movies & TV/TV/Bel-Air - Season 1 (2022)', tracks: [{ key: 'media-library/k/old.mp3', bytes: 13, sha256: SHA }] };
  const fresh = { _id: 'n', owner: KADE, state: 'ready', shared: true, title: 'Dreams and Nightmares', path: 'Audio/Needs Filing/TV/Bel-Air - Season 1 (2022)', tracks: [{ key: 'media-library/n/new.mp3', bytes: 13, sha256: SHA }] };
  const { files, KadeBook, deleted, sent } = harness([twin, fresh]);
  const r = await files.settleNewCopy(structuredClone(fresh), 0, twin, true);
  assert.strictEqual(r.action, 'merge');
  assert.strictEqual(r.tell, 'already');
  const row = KadeBook.rows.find((x) => x._id === 'n');
  assert.strictEqual(row.state, 'merged');
  assert.strictEqual(row.mergedInto, 'k');
  assert.strictEqual(row.tracks[0].key, 'media-library/k/old.mp3', 'the folded row forwards to the stored bytes');
  assert.deepStrictEqual(deleted, ['media-library/n/new.mp3']);
  assert.deepStrictEqual(sent, ['HeadObjectCommand'], 'HEAD before any delete');
});

test('if the stored copy does not answer, the new row keeps its own bytes', async () => {
  const twin = { _id: 'k', owner: KADE, state: 'ready', shared: true, tracks: [{ key: 'media-library/k/old.mp3', bytes: 13, sha256: SHA }] };
  const fresh = { _id: 'n', owner: KADE, state: 'ready', tracks: [{ key: 'media-library/n/new.mp3', bytes: 13, sha256: SHA }] };
  const { files, KadeBook, deleted } = harness([twin, fresh], { headOk: false });
  assert.deepStrictEqual(await files.settleNewCopy(structuredClone(fresh), 0, twin, true), { action: 'none' });
  assert.strictEqual(KadeBook.rows.find((x) => x._id === 'n').tracks[0].key, 'media-library/n/new.mp3');
  assert.deepStrictEqual(deleted, []);
});

test("a copy of someone else's private file is linked in silence: her row stays hers, nothing is said", async () => {
  const privateTwin = { _id: 'p', owner: AMBER, state: 'ready', shared: false, title: "Grandma's Christmas 1994", tracks: [{ key: 'media-library/p/tape.mp3', bytes: 13, sha256: SHA }] };
  const fresh = { _id: 'n', owner: KADE, state: 'ready', shared: true, title: 'Found cassette', path: 'Audio/Needs Filing', tracks: [{ key: 'media-library/n/new.mp3', bytes: 13, sha256: SHA }] };
  const { files, KadeBook, deleted, told } = harness([privateTwin, fresh]);
  const r = await files.settleNewCopy(structuredClone(fresh), 0, privateTwin, false);
  assert.strictEqual(r.action, 'link');
  assert.strictEqual(r.tell, null);
  const row = KadeBook.rows.find((x) => x._id === 'n');
  assert.strictEqual(row.state, 'ready', 'still in her list');
  assert.strictEqual(row.title, 'Found cassette', 'still her own name');
  assert.ok(!row.shortcutOf, 'a link, not a shortcut: nothing of the other row is read');
  assert.strictEqual(row.tracks[0].key, 'media-library/p/tape.mp3');
  assert.deepStrictEqual(deleted, ['media-library/n/new.mp3']);
  assert.deepStrictEqual(told, []);
});

test('a shortcut reads its keeper file under its own name, and is never more open than that file', async () => {
  const keeper = { _id: 'k', owner: KADE, state: 'ready', shared: true, grownUpsOnly: false, kind: 'audio', tracks: [{ key: 'media-library/k/a.mp3', bytes: 9, title: 'Side A', description: { state: 'done', summary: 'x' } }] };
  const shortcut = { _id: 's', owner: KADE, state: 'ready', shared: true, title: 'The Lion King', path: 'Audio/Cassettes/My cassette collection', shortcutOf: 'k', tracks: [{ key: 'media-library/k/a.mp3', bytes: 9, title: 'The Lion King' }] };
  const { files, KadeBook } = harness([keeper, shortcut]);
  const adult = { id: AMBER, admin: false, child: false, hidden: false };
  const seen = await files.withFile(shortcut, adult);
  assert.strictEqual(seen.title, 'The Lion King');
  assert.strictEqual(seen.path, 'Audio/Cassettes/My cassette collection');
  assert.strictEqual(seen.tracks[0].title, 'The Lion King', 'its own track name');
  assert.strictEqual(seen.tracks[0].description.state, 'done', "the keeper's description serves it");
  assert.strictEqual(F.fileIdOf(seen), 'k', 'text and descriptions are read from and written to the keeper');
  KadeBook.rows[0].grownUpsOnly = true;
  assert.strictEqual(await files.withFile(shortcut, { ...adult, child: true }), null, 'rule 8');
  const other = { ...shortcut, owner: AMBER };
  KadeBook.rows[0].grownUpsOnly = false;
  KadeBook.rows[0].shared = false;
  assert.strictEqual(await files.withFile(other, { id: 'someone', admin: false, child: false, hidden: false }), null, "another person's shortcut closes when the file goes private");
});
