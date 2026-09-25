'use strict';
/* THE ONE-FILE RULE (Sep 25 2026). Kade: "I need this to be a safeguard for dupes on all library
 * media, where like, it HAS to be the exact same file for a dupe flag, and then it only keeps one of
 * them. If there was some reason a file needed to be in multiple collections, it can be a shortcut
 * to the same file."
 *
 * The rules are pure functions in kadeLibraryFilesPlan.js. This file hashes stored bytes, points rows
 * at one stored copy, folds a new copy into the stored one, forwards old links, and runs the
 * librarian's maintenance passes (ETags, the hash backfill, the duplicate list, merge and undo, the
 * same-text book merge, and the objects nothing references).
 *
 *   KADE_LIBRARY_FILES           report (default): hash and mark new copies, change nothing; only a
 *                                whole item that is its owner's own copy kept elsewhere is marked
 *                                'duplicate' (plan.reportState), never both halves of a pair
 *                                on: a NEW upload of its owner's stored file is kept once; another
 *                                person's copy only shares the stored bytes (both rows stay)
 *                                off: nothing
 *   KADE_LIBRARY_FILES_DAILY_GB  bytes the verifier and the backfill may read back from B2 in a UTC
 *                                day (default 150); every byte read counts, a read that fails
 *                                part-way included. The count lives in memory (a restart resets it).
 *   KADE_LIBRARY_FILES_STALL_S   seconds a B2 read may sit without a byte before it is given up
 *                                (default 120), so a stalled GET never holds the verifier forever
 *
 * A row whose check fails is retried later (5, 10, 20, 40 minutes) and, after 5 failures, marked
 * fileCheck.state 'unchecked' so it never sits at the front of the queue.
 *
 * Duplicates that were ALREADY in the library are only folded by POST /librarian/duplicates/merge
 * with apply:true (she presses merge, not the code). A folded row is hidden and forwards to its
 * keeper for 30 days, the same 30 days B2 keeps a deleted Library file's bytes
 * (kadeStorageKeeperPlan.js hiddenLibraryDays), so every fold can be undone without restoring
 * anything from storage: the bytes it needs are the keeper's. */
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { Transform } = require('node:stream');
const plan = require('./kadeLibraryFilesPlan');

const MODE = () => {
  const mode = String(process.env.KADE_LIBRARY_FILES || 'report').toLowerCase();
  return ['on', 'off'].includes(mode) ? mode : 'report';
};
const DAILY_BYTES = () => Math.max(0.001, parseFloat(process.env.KADE_LIBRARY_FILES_DAILY_GB) || 150) * 1024 ** 3;
const STALL_MS = () => Math.max(10, (parseFloat(process.env.KADE_LIBRARY_FILES_STALL_S) || 120) * 1000);
const TOMBSTONE_DAYS = 30;
const DAY = 86400000;
const GB = 1024 ** 3;
/* A failed check waits RETRY_MS, then twice as long each time; after MAX_TRIES it is 'unchecked'. */
const RETRY_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;
const cleanEtag = plan.cleanEtag;
const gb = (bytes) => Math.round((Number(bytes) / GB) * 1000) / 1000;
const str = (v) => (v == null ? '' : String(v));
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A promise that gives up after `ms` (calling `onTimeout` first, to abort what it waits on). */
function timed(promise, ms, onTimeout) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try { if (onTimeout) onTimeout(); } catch (_) { /* the reject below still happens */ }
      reject(Object.assign(new Error(`storage sent nothing for ${Math.round(ms / 1000)} s`), { name: 'StorageStalled' }));
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * SHA-256 of a stream, chunk by chunk (never buffered).
 *   onBytes(n)  called for every chunk as it arrives, so a read that fails part-way still counts
 *   idleMs      give up when no chunk arrives for this long (a stalled GET); onStall runs first
 */
async function sha256OfStream(body, { onBytes = null, idleMs = 0, onStall = null } = {}) {
  const hash = createHash('sha256');
  let bytes = 0;
  const take = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
    if (onBytes) onBytes(buffer.length);
  };
  if (!idleMs) {
    for await (const chunk of body) take(chunk);
    return { sha256: hash.digest('hex'), bytes };
  }
  const it = body[Symbol.asyncIterator]();
  for (;;) {
    const step = await timed(it.next(), idleMs, () => {
      if (onStall) onStall();
      if (body && typeof body.destroy === 'function') body.destroy();
    });
    if (step.done) break;
    take(step.value);
  }
  return { sha256: hash.digest('hex'), bytes };
}
const sha256OfFile = (path) => sha256OfStream(createReadStream(path));
const sha256OfBuffer = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** A pass-through that hashes what flows through it: put it in a pipeline the bytes already take
 * (the book import's download, a DAISY clip on its way to B2) and it costs no extra read. */
function hashingStream() {
  const hash = createHash('sha256');
  let bytes = 0;
  let digest = '';
  const stream = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  stream.result = () => {
    if (!digest) digest = hash.digest('hex');
    return { sha256: digest, bytes };
  };
  return stream;
}

/**
 * The objects under media-library/<itemId>/ that no row lists, classified by
 * plan.classifyUnreferenced. Reads the catalog only (never storage). Shared by the librarian's
 * POST /librarian/files/unreferenced and the storage keeper's daily report.
 * @param {object} KadeBook
 * @param {Array<{ key: string, size: number, etag?: string, lastModified: string|Date }>} objects
 */
async function unreferencedIn(KadeBook, objects, { now = Date.now() } = {}) {
  const list = (objects || []).filter((o) => o && o.key);
  const byKey = new Map(list.map((o) => [o.key, o]));
  const referenced = new Set();
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    const rows = await KadeBook.find({ $or: [{ 'tracks.key': { $in: batch } }, { fileKey: { $in: batch } }] }, 'tracks.key fileKey').lean();
    const wanted = new Set(batch);
    for (const r of rows) {
      for (const t of r.tracks || []) if (t && wanted.has(t.key)) referenced.add(t.key);
      if (r.fileKey && wanted.has(r.fileKey)) referenced.add(r.fileKey);
    }
  }
  const loose = list.filter((o) => !referenced.has(o.key));
  const ids = [...new Set(loose.map((o) => plan.itemOfKey(o.key)).filter(Boolean))];
  const itemKeys = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await KadeBook.find({ _id: { $in: ids.slice(i, i + 1000) } }, '_id tracks.key tracks.bytes tracks.sha256 tracks.etag').lean();
    for (const r of rows) {
      itemKeys.set(str(r._id).toLowerCase(), (r.tracks || []).filter((t) => t && t.key).map((t) => {
        const o = byKey.get(t.key);
        return { key: t.key, size: o ? o.size : t.bytes, etag: o ? o.etag : t.etag, sha256: t.sha256 || '' };
      }));
    }
  }
  const entries = plan.classifyUnreferenced(loose, { referenced, itemKeys, now });
  const deletable = entries.filter((e) => e.deletable);
  return {
    listed: list.length,
    count: entries.length,
    gb: gb(entries.reduce((n, e) => n + e.size, 0)),
    identical: deletable.length,
    identicalGb: gb(deletable.reduce((n, e) => n + e.size, 0)),
    entries,
  };
}

/**
 * @param {object} deps
 *   models   { KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection,
 *              KadeLibrarySubmission, Receipts?, Requests?, DescriptionJobs? }
 *   s3, bucket   the reading room's s3() and MEDIA_BUCKET()
 *   deleteKeys   the reading room's deleteKeys (a plain delete, so B2 hides rather than destroys)
 *   readerOf     async (userId) => { id, admin, child, hidden } (kadeLibraryRequests.requestReader)
 *   notify       (userId, text) => void (the reading room's notifyUser)
 *   where        (row) => the folder a person sees (libraryPath)
 *   keyFromFileUrl  (fileUrl) => the stored original's key, for rows older than `fileKey`
 *   prefix       () => the media prefix ('media-library')
 */
function createLibraryFiles({ models, s3, bucket, deleteKeys, readerOf, notify = () => {}, where = (row) => row.path || '', log = () => {}, keyFromFileUrl = () => '', prefix = () => 'media-library' }) {
  const m = models;
  const { KadeBook } = m;
  let read = { day: '', bytes: 0 };
  let running = false;
  const today = () => new Date().toISOString().slice(0, 10);
  const spentToday = () => (read.day === today() ? read.bytes : 0);
  const spend = (bytes) => {
    if (read.day !== today()) read = { day: today(), bytes: 0 };
    read.bytes += bytes;
  };
  const overBudget = () => spentToday() >= DAILY_BYTES();
  const fileKeyOf = (row) => (row && (row.fileKey || keyFromFileUrl(row.fileUrl))) || '';
  const keysOf = (row) => [...((row && row.tracks) || []).map((t) => t && t.key), fileKeyOf(row)].filter(Boolean);

  /** SHA-256 of a stored object, streamed from B2 (never buffered). Every byte counts against the
   * day's budget as it arrives (a read that drops part-way included), and a GET that sends nothing
   * for STALL_MS is aborted, so one stalled read can never hold the verifier. */
  async function sha256Of(key) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const abort = new AbortController();
    const idleMs = STALL_MS();
    const out = await timed(s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }), { abortSignal: abort.signal }), idleMs, () => abort.abort());
    const result = await sha256OfStream(out.Body, { onBytes: spend, idleMs, onStall: () => abort.abort() });
    return { ...result, etag: cleanEtag(out.ETag) };
  }

  /** Hash one stored object and write it on every row that lists the key (linked rows share it). */
  async function hashKey(key) {
    const result = await sha256Of(key);
    await KadeBook.updateMany(
      { 'tracks.key': key },
      { $set: { 'tracks.$[x].sha256': result.sha256, 'tracks.$[x].etag': result.etag } },
      { arrayFilters: [{ 'x.key': key }] },
    );
    return result;
  }
  /** The same for a stored original (a text book's file). */
  async function hashFileKey(key) {
    const result = await sha256Of(key);
    await KadeBook.updateMany({ fileKey: key }, { $set: { fileSha256: result.sha256 } });
    return result;
  }

  /** Ready rows holding this exact file, as a track or as a book's original. */
  function holders(sha256, bytes) {
    return KadeBook.find({
      state: 'ready',
      $or: [{ tracks: { $elemMatch: { sha256, bytes } } }, { fileSha256: sha256, fileBytes: bytes }],
    }).limit(50).lean();
  }

  /** One-file decisions judge a copy the way the library judges it for everyone: the admin's override
   * (she can open every row) never makes someone else's private copy count as one she can open, so
   * her upload is never skipped or folded for it, and "Already in the library" is never said of it. */
  const asUploader = (reader) => (reader ? { ...reader, admin: false } : reader);

  /** The stored copy an upload is measured against: one the uploader can open (so they can be told),
   * otherwise any (a silent link). A row that is itself a file wins over a shortcut to it, and a row
   * report mode already marked as an extra copy is used only when nothing else holds the file. */
  async function storedTwin(reader, sha256, bytes, { except = null } = {}) {
    if (!plan.SHA256.test(str(sha256)) || !(Number(bytes) > 0)) return null;
    const rows = (await holders(sha256, Number(bytes))).filter((row) => str(row._id) !== str(except));
    if (!rows.length) return null;
    const prefer = (list, good) => (list.some(good) ? list.filter(good) : list);
    const pick = (list) => plan.chooseKeeper(prefer(prefer(list, (r) => !plan.flaggedCopy(r)), (r) => !r.shortcutOf));
    const uploader = asUploader(reader);
    const visible = rows.filter((row) => plan.canOpen(uploader, row));
    const own = reader ? visible.filter((row) => str(row.owner) === str(reader.id)) : [];
    return { twin: pick(own.length ? own : visible.length ? visible : rows), canOpen: visible.length > 0 };
  }

  /** Rows older than `fileKey` name their book original only in fileUrl (until fillFileKeys runs):
   * the key as it appears at the end of the URL's path, raw or percent-encoded. */
  const fileUrlPattern = (key) => `(?:${[...new Set([key, encodeURI(key)])].map((k) => escapeRegExp(`/${k}`)).join('|')})(?:[?#]|$)`;

  /** Delete stored objects no row lists any more (any state: a folded row still lists its keeper's
   * bytes until it is purged), as a track, as `fileKey`, or (older rows) inside `fileUrl`. A plain
   * delete: B2 hides the bytes (30 days, see the storage keeper) before anything is gone for good. */
  async function releaseKeys(keys, { except = [] } = {}) {
    const gone = [];
    for (const key of new Set((keys || []).filter(Boolean))) {
      let used = await KadeBook.exists({ _id: { $nin: except }, $or: [{ 'tracks.key': key }, { fileKey: key }] });
      if (!used && String(key).startsWith('books/')) used = await KadeBook.exists({ _id: { $nin: except }, fileUrl: { $regex: fileUrlPattern(key) } });
      if (!used) gone.push(key);
    }
    if (gone.length) await deleteKeys(gone);
    return gone;
  }

  /** Before new bytes go: the stored object answers HEAD and the keeper row still lists it. */
  async function stillThere(keeperId, key) {
    const listed = await KadeBook.exists({ _id: keeperId, state: 'ready', $or: [{ 'tracks.key': key }, { fileKey: key }] });
    if (!listed) return false;
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
      return true;
    } catch (_) {
      return false;
    }
  }

  const counts = (row) => ((row && row.sections) || []).map((x) => x.chunkCount || 0);
  /** Where a place in E lands in K. `sameText`: the two rows hold the same words section for
   * section (only the spoken jacket may differ), so a place keeps its section. Otherwise a text
   * cut by another parser version moves by its flat chunk index (the reparse rule). */
  function placeIn(extra, keeper, s, c, sameText) {
    if (!extra || !keeper || extra.kind !== 'text') return { s, c };
    const from = counts(extra);
    const to = counts(keeper);
    if (sameText) {
      const si = Math.max(0, Math.min(Number(s) || 0, Math.max(0, to.length - 1)));
      return { s: si, c: Math.max(0, Math.min(Number(c) || 0, Math.max(0, (to[si] || 1) - 1))) };
    }
    if (JSON.stringify(from) === JSON.stringify(to)) return { s, c };
    return plan.remapPosition(from, to, s || 0, c || 0);
  }

  /** Move every reference from row E to row K. Returns what moved, for the undo receipt. */
  async function repoint(E, K, { extra = null, keeper = null, sameText = false } = {}) {
    const refs = { progress: [], bookmarks: [], collections: [], submissions: [], requests: [], jobs: [], links: [] };
    // Readers: one place per person per file; the more recent place wins, "finished" is kept.
    for (const r of await m.KadeReadingProgress.find({ book: E }).lean()) {
      const to = placeIn(extra, keeper, r.s, r.c, sameText);
      const theirs = await m.KadeReadingProgress.findOne({ user: r.user, book: K }).lean();
      if (!theirs) {
        await m.KadeReadingProgress.updateOne({ _id: r._id }, { $set: { book: K, s: to.s, c: to.c } });
        refs.progress.push({ id: r._id, moved: true, s: r.s, c: r.c });
      } else {
        const set = { finished: !!(r.finished || theirs.finished) };
        if (new Date(r.updatedAt) > new Date(theirs.updatedAt)) Object.assign(set, { s: to.s, c: to.c, pos: r.pos || 0, voice: r.voice || '', speed: r.speed || 1 });
        await m.KadeReadingProgress.updateOne({ _id: theirs._id }, { $set: set });
        await m.KadeReadingProgress.deleteOne({ _id: r._id });
        refs.progress.push({ id: r._id, row: r, into: theirs._id, before: { s: theirs.s, c: theirs.c, pos: theirs.pos || 0, voice: theirs.voice || '', speed: theirs.speed || 1, finished: !!theirs.finished } });
      }
    }
    // Bookmarks: the same words, even if the two rows were cut by different parser versions.
    for (const b of await m.KadeReadingBookmark.find({ book: E }).lean()) {
      const to = placeIn(extra, keeper, b.s, b.c, sameText);
      await m.KadeReadingBookmark.updateOne({ _id: b._id }, { $set: { book: K, s: to.s, c: to.c } });
      refs.bookmarks.push({ id: b._id, s: b.s, c: b.c });
    }
    // Lists (collections hold item ids, so a list entry already is a shortcut: it follows the file).
    for (const c of await m.KadeCollection.find({ 'items.book': E }, '_id items.book').lean()) {
      const idx = (c.items || []).map((it, i) => (str(it.book) === str(E) ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      await m.KadeCollection.updateOne({ _id: c._id }, { $set: Object.fromEntries(idx.map((i) => [`items.${i}.book`, K])) });
      refs.collections.push({ id: c._id, idx });
    }
    for (const s of await m.KadeLibrarySubmission.find({ book: E }, '_id').lean()) {
      await m.KadeLibrarySubmission.updateOne({ _id: s._id }, { $set: { book: K } });
      refs.submissions.push(s._id);
    }
    if (m.Requests) {
      for (const q of await m.Requests.find({ book: str(E) }, '_id').lean()) {
        await m.Requests.updateOne({ _id: q._id }, { $set: { book: str(K) } });
        refs.requests.push(q._id);
      }
    }
    if (m.DescriptionJobs) {
      const e = str(E);
      const k = str(K);
      for (const j of await m.DescriptionJobs.find({ $or: [{ 'library.book': e }, { savedToLibrary: e }, { 'copies.savedToLibrary': e }] }, '_id library savedToLibrary copies').lean()) {
        const set = {};
        const entry = { id: j._id, fields: [], copies: [] };
        if (j.library && str(j.library.book) === e) { set['library.book'] = k; entry.fields.push('library.book'); }
        if (str(j.savedToLibrary) === e) { set.savedToLibrary = k; entry.fields.push('savedToLibrary'); }
        (j.copies || []).forEach((copy, i) => {
          if (copy && str(copy.savedToLibrary) === e) { set[`copies.${i}.savedToLibrary`] = k; entry.copies.push(i); }
        });
        if (Object.keys(set).length) {
          await m.DescriptionJobs.updateOne({ _id: j._id }, { $set: set });
          refs.jobs.push(entry);
        }
      }
    }
    // Rows that point at E: a described copy and its original, a transcript, shortcuts, and copies
    // folded into E earlier (so their old links keep forwarding).
    let K_row = keeper;
    for (const [field, value] of [['meta.describedCopy', str(E)], ['meta.describedFrom.book', str(E)], ['meta.describedTranscriptOf', str(E)], ['shortcutOf', E], ['mergedInto', E]]) {
      for (const r of await KadeBook.find({ [field]: value, _id: { $ne: K } }, '_id tracks fileSha256 fileBytes fileKey fileUrl').lean()) {
        const set = { [field]: field === 'shortcutOf' || field === 'mergedInto' ? K : str(K) };
        if (field === 'shortcutOf') {
          // A shortcut's own copy of the track list follows the file too, so E's bytes are not kept alive by it.
          K_row = K_row || (await KadeBook.findById(K, 'tracks fileSha256 fileBytes fileKey fileUrl').lean());
          if (K_row) {
            set.tracks = relinked(r, K_row);
            if (r.fileSha256 && r.fileSha256 === K_row.fileSha256 && fileKeyOf(K_row)) Object.assign(set, { fileKey: fileKeyOf(K_row), fileUrl: K_row.fileUrl || '' });
          }
        }
        await KadeBook.updateOne({ _id: r._id }, { $set: set });
        refs.links.push({ id: r._id, field });
      }
    }
    return refs;
  }

  /** Paid or human work on a copy is never thrown away: the keeper takes what it lacks. */
  function carryOver(keeper, extra, keeperSet = {}) {
    const set = { ...keeperSet };
    (extra.tracks || []).forEach((t, i) => {
      const k = (keeper.tracks || [])[i];
      if (!k || !plan.sameFile(k, t)) return;
      if (t.description && t.description.state === 'done' && !(k.description && k.description.state === 'done')) set[`tracks.${i}.description`] = t.description;
      if ((t.recaps || []).length && !(k.recaps || []).length) set[`tracks.${i}.recaps`] = t.recaps;
    });
    if (extra.librarian && extra.librarian.state === 'done' && !(keeper.librarian && keeper.librarian.state === 'done')) set.librarian = extra.librarian;
    if (extra.description && !keeper.description) set.description = extra.description;
    return set;
  }

  /** The extra row's tracks, pointed at the keeper's stored bytes (same file). */
  const relinked = (extra, keeper) => (extra.tracks || []).map((t, i) => {
    const k = (keeper.tracks || []).find((x) => plan.sameFile(x, t)) || (keeper.tracks || [])[i];
    return k && plan.sameFile(k, t) ? { ...t, key: k.key } : t;
  });

  /**
   * Fold one extra row into its keeper: 'merge' (hidden, forwarded, references moved), 'shortcut'
   * (stays in its folder, reads the keeper's file) or 'link' (stays another person's own; only the
   * bytes are shared). Returns the undo receipt entry.
   *   whole: the caller proved the two rows read the same (the same-text book merge); otherwise only
   *          a row whose every file the keeper holds may lose its row.
   *   keepOwnFiles: leave the extra's stored bytes where they are (the same-text merge: its original
   *          is a different file; it goes with the row after the 30 days).
   */
  async function foldInto(keeper, extra, action, keeperSet = {}, { whole = false, keepOwnFiles = false, sameText = false } = {}) {
    const K = keeper._id;
    const E = extra._id;
    if (str(K) === str(E)) return { id: str(E), action: 'skipped', why: 'the keeper itself' };
    if (!(whole || plan.wholeCopy(extra, keeper)) && action !== 'link') action = 'link'; // only a whole copy may lose its row
    const shareable = (extra.tracks || []).some((t) => (keeper.tracks || []).some((k) => plan.sameFile(k, t) && k.key !== t.key))
      || (!!extra.fileSha256 && extra.fileSha256 === keeper.fileSha256 && Number(extra.fileBytes) === Number(keeper.fileBytes) && !!fileKeyOf(keeper) && fileKeyOf(keeper) !== fileKeyOf(extra));
    if (action === 'link' && (keepOwnFiles || !shareable)) return { id: str(E), action: 'skipped', why: 'nothing to share' };
    const before = { state: extra.state, shortcutOf: extra.shortcutOf || null, shared: !!extra.shared, keys: keysOf(extra) };
    const set = keepOwnFiles ? {} : {
      tracks: relinked(extra, keeper),
      ...(extra.fileSha256 && extra.fileSha256 === keeper.fileSha256 && Number(extra.fileBytes) === Number(keeper.fileBytes) && fileKeyOf(keeper)
        ? { fileKey: fileKeyOf(keeper), fileUrl: keeper.fileUrl || '' } : {}),
    };
    if (action === 'shortcut') {
      set.shortcutOf = K;
      /* Never more open than its file (rule 8): a shortcut to a grown-ups file (or to one taking the
       * stricter flag in this fold) is grown-ups too; the receipt says so, so an undo opens it again. */
      if ((keeper.grownUpsOnly || keeperSet.grownUpsOnly) && !extra.grownUpsOnly) {
        set.grownUpsOnly = true;
        before.madeGrownUps = true;
      }
    } else if (action === 'merge') Object.assign(set, { state: 'merged', mergedInto: K, mergedAt: new Date(), shared: false });
    // The row is claimed first, so a copy that changed since it was read is left alone, whole.
    const r = await KadeBook.updateOne({ _id: E, state: 'ready' }, { $set: set });
    if (!r.modifiedCount) return { id: str(E), action: 'skipped', why: 'the row changed or went since it was read' };
    const carried = action === 'link' ? {} : carryOver(keeper, extra, keeperSet);
    if (Object.keys(carried).length) await KadeBook.updateOne({ _id: K, state: 'ready' }, { $set: carried });
    const refs = action === 'merge' ? await repoint(E, K, { extra, keeper, sameText }) : {};
    const after = keysOf({ ...extra, ...set });
    const released = keepOwnFiles ? [] : await releaseKeys(before.keys.filter((key) => !after.includes(key)));
    return { id: str(E), action, before, refs, released };
  }

  /** Put a folded row back, with every reference it had (inside the 30 days). Its tracks keep
   * pointing at the keeper's bytes, which are the same file, so nothing is restored from storage. */
  async function undoFold(entry, keeperId) {
    const E = entry.id;
    const K = keeperId;
    const before = entry.before || {};
    if (entry.action === 'merge') {
      await KadeBook.updateOne({ _id: E, state: 'merged' }, { $set: { state: 'ready', shared: !!before.shared }, $unset: { mergedInto: 1, mergedAt: 1 } });
    }
    if (entry.action === 'shortcut') {
      const back = before.shortcutOf ? { $set: { shortcutOf: before.shortcutOf } } : { $unset: { shortcutOf: 1 } };
      if (before.madeGrownUps) back.$set = { ...(back.$set || {}), grownUpsOnly: false };
      await KadeBook.updateOne({ _id: E, shortcutOf: K }, back);
    }
    const refs = entry.refs || {};
    for (const p of refs.progress || []) {
      if (p.moved) await m.KadeReadingProgress.updateOne({ _id: p.id, book: K }, { $set: { book: E, s: p.s || 0, c: p.c || 0 } });
      else {
        const { _id, __v, ...row } = p.row || {};
        await m.KadeReadingProgress.create({ _id: p.id, ...row, book: E }).catch(() => {});
        if (p.before) await m.KadeReadingProgress.updateOne({ _id: p.into }, { $set: p.before });
      }
    }
    for (const b of refs.bookmarks || []) await m.KadeReadingBookmark.updateOne({ _id: b.id }, { $set: { book: E, s: b.s || 0, c: b.c || 0 } });
    for (const c of refs.collections || []) {
      for (const i of c.idx || []) await m.KadeCollection.updateOne({ _id: c.id, [`items.${i}.book`]: K }, { $set: { [`items.${i}.book`]: E } });
    }
    for (const id of refs.submissions || []) await m.KadeLibrarySubmission.updateOne({ _id: id, book: K }, { $set: { book: E } });
    if (m.Requests) for (const id of refs.requests || []) await m.Requests.updateOne({ _id: id, book: str(K) }, { $set: { book: str(E) } });
    if (m.DescriptionJobs) {
      for (const j of refs.jobs || []) {
        const set = {};
        for (const f of j.fields || []) set[f] = str(E);
        for (const i of j.copies || []) set[`copies.${i}.savedToLibrary`] = str(E);
        if (Object.keys(set).length) await m.DescriptionJobs.updateOne({ _id: j.id }, { $set: set });
      }
    }
    for (const l of refs.links || []) {
      const back = l.field === 'shortcutOf' || l.field === 'mergedInto' ? E : str(E);
      await KadeBook.updateOne({ _id: l.id }, { $set: { [l.field]: back } });
    }
  }

  /**
   * Track `t` of a NEW row holds the same file as a track of `twin`. Point it at the stored bytes,
   * prove they are there, then let the new bytes go. plan.uploadDecision decides the row's fate.
   */
  async function settleNewCopy(item, t, twin, canOpenTwin) {
    const mine = item.tracks[t];
    const theirs = (twin.tracks || []).find((x) => plan.sameFile(x, mine));
    if (!theirs || !theirs.key || theirs.key === mine.key) return { action: 'none' };
    if (!(await stillThere(twin._id, theirs.key))) return { action: 'none' }; // keep our own bytes
    const decision = plan.uploadDecision({ item, twin, canOpen: canOpenTwin });
    const whole = (item.tracks || []).length === 1 && (twin.tracks || []).length === 1;
    const now = new Date();
    const set = { [`tracks.${t}.key`]: theirs.key, [`tracks.${t}.sha256`]: mine.sha256, 'fileCheck.state': 'linked', 'fileCheck.of': twin._id, 'fileCheck.at': now };
    if (whole && decision.action === 'merge') Object.assign(set, { state: 'merged', mergedInto: twin._id, mergedAt: now, shared: false, 'fileCheck.state': 'folded' });
    else if (whole && decision.action === 'shortcut') {
      set.shortcutOf = twin._id;
      if (twin.grownUpsOnly && !item.grownUpsOnly) set.grownUpsOnly = true; // never more open than its file
    }
    const r = await KadeBook.updateOne({ _id: item._id, state: 'ready', [`tracks.${t}.key`]: mine.key }, { $set: set });
    if (!r.modifiedCount) return { action: 'none' }; // raced an edit or a delete
    const refs = set.state === 'merged' ? await repoint(item._id, twin._id) : null;
    const released = await releaseKeys([mine.key]);
    const action = set.state === 'merged' ? 'merge' : set.shortcutOf ? 'shortcut' : 'link';
    if (action === 'merge' && m.Receipts) {
      /* A receipt like the librarian's merge, so the fold can be put back for 30 days; it keeps the
       * upload's own title and notes (the uploader is told they are saved). */
      await m.Receipts.create({
        kind: 'file', group: plan.groupId(mine.sha256, mine.bytes), keeper: twin._id, by: 'verifier', keeperBefore: {},
        entries: [{ id: str(item._id), action: 'merge', before: { state: 'ready', shortcutOf: null, shared: !!item.shared, keys: [mine.key], title: item.title || '', description: item.description || '' }, refs, released }],
      }).catch((e) => log(`[library/files] receipt for ${str(item._id)} not written: ${e.message}`));
    }
    log(`[library/files] ${str(item._id)} track ${t}: ${action} with ${str(twin._id)}`);
    // `tell` is null for a twin the uploader could not open: nothing about it is ever said.
    return { action, tell: action === 'merge' ? decision.tell : null, twin };
  }

  /**
   * Report mode's verdict on a NEW row some of whose tracks are stored elsewhere (plan.reportState):
   * 'duplicate' only when the whole item is the same file as one ready row, track for track, and that
   * row is the uploader's own copy that stays. Rows already marked as the extra copy never count as
   * the one that stays. When the other copy is new too (one push sent the same file from two drive
   * folders, as on Sep 24), the better copy stays and only the other is marked, whichever came first.
   */
  async function judgeCopy(item, tracks, reader) {
    const fresh = { ...item, tracks };
    const first = tracks[0];
    if (!first || !plan.SHA256.test(str(first.sha256))) return { state: 'shares-tracks' };
    const whole = (await holders(first.sha256, Number(first.bytes))).filter((r) => str(r._id) !== str(item._id) && plan.wholeCopy(fresh, r));
    if (!whole.length) return { state: 'shares-tracks' };
    const usable = whole.filter((r) => !plan.flaggedCopy(r));
    if (!usable.length) return { state: 'kept', of: whole[0]._id }; // every other copy is already the marked one
    const files = usable.some((r) => !r.shortcutOf) ? usable.filter((r) => !r.shortcutOf) : usable;
    const uploader = asUploader(reader);
    const visible = files.filter((r) => plan.canOpen(uploader, r));
    // The owner's own copy is the one to measure against first, so a real extra copy of her own is
    // never missed because someone else's shared copy of the same file won the pick.
    const own = visible.filter((r) => str(r.owner) === str(item.owner));
    const twin = plan.chooseKeeper(own.length ? own : visible.length ? visible : files);
    if (plan.reportState({ item: fresh, twin, canOpen: visible.length > 0, whole: true }) !== 'duplicate') return { state: 'kept', of: twin._id };
    const twinIsNew = twin.fileCheck && twin.fileCheck.state === 'pending';
    if (twinIsNew && plan.chooseKeeper([twin, fresh]) === fresh && plan.reportState({ item: twin, twin: { ...fresh, state: 'ready' }, canOpen: true, whole: true }) === 'duplicate') {
      const r = await KadeBook.updateOne({ _id: twin._id, state: 'ready', 'fileCheck.state': 'pending' }, { $set: { 'fileCheck.state': 'duplicate', 'fileCheck.of': item._id, 'fileCheck.at': new Date() } });
      if (r.modifiedCount) return { state: 'kept', of: twin._id };
    }
    return { state: 'duplicate', of: twin._id };
  }

  /** A row whose check failed waits longer each time; after MAX_TRIES it is 'unchecked', so it can
   * never hold the front of the queue (the media sweep then files it without a duplicate flag). */
  async function backOff(item, error) {
    const tries = (Number(item.fileCheck && item.fileCheck.tries) || 0) + 1;
    const set = { 'fileCheck.tries': tries, 'fileCheck.error': str(error && error.message ? error.message : error).slice(0, 200) };
    if (tries >= MAX_TRIES) set['fileCheck.state'] = 'unchecked';
    else set['fileCheck.next'] = new Date(Date.now() + RETRY_MS * 2 ** (tries - 1));
    await KadeBook.updateOne({ _id: item._id, 'fileCheck.state': 'pending' }, { $set: set });
    return tries >= MAX_TRIES ? 'unchecked' : 'failed';
  }

  /**
   * Check one row's tracks against every stored file of the same size. Most sizes are unique (52,540
   * of 55,987 objects on Sep 25), so most rows are settled without reading a byte.
   * `memo`: hashes read in this pass, by key (a DAISY book lists one mp3 under many clips; it is read once).
   */
  async function verifyItem(item, { memo = new Map() } = {}) {
    const reader = await readerOf(item.owner);
    const report = MODE() !== 'on';
    const tracks = (item.tracks || []).map((x) => (x ? { ...x } : x));
    for (const x of tracks) if (x && x.key && x.sha256 && !memo.has(x.key)) memo.set(x.key, x.sha256);
    const known = (x) => {
      if (x.sha256) return true;
      if (!memo.has(x.key)) return false;
      x.sha256 = memo.get(x.key);
      return true;
    };
    const hashOf = async (key) => {
      const sha256 = (await hashKey(key)).sha256;
      memo.set(key, sha256);
      return sha256;
    };
    let outcome = 'unique';
    let matched = 0;
    for (let t = 0; t < tracks.length; t++) {
      const tr = tracks[t];
      if (!tr || !tr.key || !(Number(tr.bytes) > 0)) continue;
      const mates = (await KadeBook.find({ _id: { $ne: item._id }, state: 'ready', 'tracks.bytes': tr.bytes }, '_id owner shared grownUpsOnly state path kind title tracks librarian shortcutOf fileCheck').limit(50).lean())
        .filter((row) => (row.tracks || []).some((x) => x.bytes === tr.bytes && x.key !== tr.key && plan.etagVerdict(tr, x) !== 'different'));
      if (!mates.length) continue; // no other stored file of this size can be this file
      if (!known(tr)) {
        if (overBudget()) return 'waiting';
        tr.sha256 = await hashOf(tr.key);
      }
      const sha256 = tr.sha256;
      for (const row of mates) {
        for (const x of row.tracks || []) {
          if (x.bytes !== tr.bytes || x.key === tr.key || plan.etagVerdict(tr, x) === 'different' || known(x)) continue;
          if (overBudget()) return 'waiting';
          x.sha256 = await hashOf(x.key);
        }
      }
      const found = await storedTwin(reader, sha256, tr.bytes, { except: item._id });
      if (!found) continue;
      matched++;
      if (report) continue; // judged as a whole item below: one shared track is never a duplicate
      const fresh = { ...item, tracks };
      /* Both copies are new (one push sent the same file from two drive folders, as on Sep 24):
       * the better copy stays, whichever arrived first. */
      const twinIsNew = found.twin.fileCheck && found.twin.fileCheck.state === 'pending';
      if (twinIsNew && str(found.twin.owner) === str(item.owner) && plan.chooseKeeper([found.twin, fresh]) === fresh) {
        const u = (found.twin.tracks || []).findIndex((x) => plan.sameFile(x, { sha256, bytes: tr.bytes }));
        const reverse = u >= 0 ? await settleNewCopy(found.twin, u, fresh, true) : { action: 'none' };
        if (reverse.action !== 'none') { outcome = 'kept'; continue; }
      }
      const settled = await settleNewCopy(fresh, t, found.twin, found.canOpen);
      if (settled.action === 'merge') return settled.tell ? `folded:${str(found.twin._id)}` : 'folded';
      if (settled.action !== 'none') outcome = 'linked';
    }
    const set = { 'fileCheck.state': outcome, 'fileCheck.at': new Date() };
    if (report && matched) {
      const verdict = await judgeCopy(item, tracks, reader);
      Object.assign(set, { 'fileCheck.state': verdict.state, ...(verdict.of ? { 'fileCheck.of': verdict.of } : {}) });
    }
    await KadeBook.updateOne({ _id: item._id, 'fileCheck.state': 'pending' }, { $set: set });
    return set['fileCheck.state'];
  }

  /** One pass over rows waiting to be checked (a row that failed waits for its retry time). One
   * grouped message per uploader per pass. */
  async function verifyPass({ limit = 20 } = {}) {
    if (MODE() === 'off' || running) return null;
    running = true;
    const tally = {};
    const told = new Map();
    const memo = new Map();
    try {
      const items = await KadeBook.find({ 'fileCheck.state': 'pending', state: 'ready', 'fileCheck.next': { $not: { $gt: new Date() } } }, '_id').sort({ _id: 1 }).limit(limit).lean();
      for (const listed of items) {
        // Read now, not at the top of the pass: the other half of a same-pass pair may be settled already.
        const item = await KadeBook.findOne({ _id: listed._id, state: 'ready', 'fileCheck.state': 'pending' }).lean();
        if (!item) continue;
        const outcome = await verifyItem(item, { memo }).catch(async (e) => {
          log(`[library/files] check of ${str(item._id)} failed: ${e.message}`);
          return backOff(item, e).catch(() => 'failed');
        });
        const kind = outcome.split(':')[0];
        tally[kind] = (tally[kind] || 0) + 1;
        if (outcome.startsWith('folded:')) told.set(str(item.owner), [...(told.get(str(item.owner)) || []), { title: item.title, description: item.description || '', twin: outcome.slice(7) }]);
        if (kind === 'waiting') break;
      }
      for (const [owner, list] of told) {
        const found = await KadeBook.find({ _id: { $in: list.map((x) => x.twin) } }, '_id title description owner shared path kind category').lean().catch(() => []);
        const twins = new Map(found.map((r) => [str(r._id), r]));
        let text = plan.foldedSummary(list.length, list.some((x) => plan.ownWords(x, twins.get(x.twin))));
        if (list.length === 1) {
          const twin = twins.get(list[0].twin);
          text = twin
            ? plan.foldedLine(twin, twin.shared ? where(twin) : '', { own: str(twin.owner) === owner && !twin.shared, mine: list[0] })
            : `"${list[0].title}" was already in the library as exactly the same file, so it is kept once.`;
        }
        notify(owner, text);
      }
      await purgeTombstones();
      return tally;
    } finally {
      running = false;
    }
  }

  /**
   * The backfill: hash only stored objects that share their exact size with another object and whose
   * ETags do not already prove them different, and book originals that share their size. It never
   * folds anything (that is Kade's merge). Sep 25 listing: 1,575 size groups; 251 of them (578
   * objects) are settled by the ETag alone; the 1,410 same-size same-ETag groups (2,862 objects,
   * 76.6 GB) are what gets read.
   */
  async function hashCollisions({ limit = 5000, limitBytes = Infinity } = {}) {
    const start = spentToday();
    const readThisCall = () => spentToday() - start;
    const stop = (hashed) => overBudget() || hashed >= limit || readThisCall() >= limitBytes;
    const tallies = { hashed: 0, settledByEtag: 0, waiting: false, groups: 0, books: { hashed: 0, groups: 0 } };
    const groups = await KadeBook.aggregate([
      { $match: { state: { $in: ['ready', 'pending'] }, 'tracks.bytes': { $gt: 0 } } },
      { $unwind: '$tracks' },
      { $match: { 'tracks.bytes': { $gt: 0 }, 'tracks.key': { $gt: '' } } },
      { $group: { _id: '$tracks.bytes', t: { $addToSet: { key: '$tracks.key', etag: '$tracks.etag', sha256: '$tracks.sha256' } } } },
      { $match: { 't.1': { $exists: true } } },
    ]).allowDiskUse(true);
    for (const g of groups) {
      const members = [...new Map(g.t.map((x) => [x.key, x])).values()];
      if (members.length < 2) continue;
      tallies.groups++;
      for (const x of members) {
        if (x.sha256) continue;
        const open = members.some((y) => y.key !== x.key && plan.etagVerdict(x, y) !== 'different');
        if (!open) { tallies.settledByEtag++; continue; }
        if (stop(tallies.hashed)) return { ...tallies, waiting: true, gbRead: gb(readThisCall()) };
        x.sha256 = (await hashKey(x.key)).sha256;
        tallies.hashed++;
      }
    }
    const books = await KadeBook.aggregate([
      { $match: { state: { $in: ['ready', 'merged'] }, fileKey: { $gt: '' }, fileBytes: { $gt: 0 } } },
      { $group: { _id: '$fileBytes', f: { $addToSet: { key: '$fileKey', sha256: '$fileSha256' } } } },
      { $match: { 'f.1': { $exists: true } } },
    ]).allowDiskUse(true);
    for (const g of books) {
      const members = [...new Map(g.f.map((x) => [x.key, x])).values()];
      if (members.length < 2) continue;
      tallies.books.groups++;
      for (const x of members) {
        if (x.sha256) continue;
        if (stop(tallies.hashed)) return { ...tallies, waiting: true, gbRead: gb(readThisCall()) };
        await hashFileKey(x.key);
        tallies.hashed++;
        tallies.books.hashed++;
      }
    }
    return { ...tallies, gbRead: gb(readThisCall()) };
  }

  /** After 30 days a folded row goes for good; its tracks point at the keeper's bytes, so
   * releaseKeys keeps them for as long as the keeper (or any link) lists them. */
  async function purgeTombstones() {
    const old = await KadeBook.find({ state: 'merged', mergedAt: { $lt: new Date(Date.now() - TOMBSTONE_DAYS * DAY) } }, '_id tracks.key fileKey fileUrl').limit(200).lean();
    for (const row of old) {
      await m.KadeBookText.deleteOne({ book: row._id });
      const r = await KadeBook.deleteOne({ _id: row._id, state: 'merged' });
      if (r && r.deletedCount === 0) continue;
      await releaseKeys(keysOf(row), { except: [row._id] });
    }
    return old.length;
  }

  /** Before a row is withdrawn: if its OWNER's shortcuts read its file, the oldest becomes the file
   * (it takes the track list with its descriptions, the text summary, and the book text, keeping its
   * own track names and the stricter grown-ups flag), the owner's other shortcuts follow it, and
   * copies folded into the withdrawn row forward to it. Shortcuts other people made to it never
   * inherit it: they go with it (foreignShortcuts), so a withdrawal really withdraws.
   * `except`: rows going in the same batch, which never inherit. */
  async function promoteShortcuts(row, { except = [] } = {}) {
    const skip = [...except].map(str);
    const next = await KadeBook.findOne({ shortcutOf: row._id, owner: row.owner, state: 'ready', ...(skip.length ? { _id: { $nin: skip } } : {}) }).sort({ _id: 1 }).lean();
    if (!next) return null;
    /* The text first (KadeBookText.book is unique): a shortcut made by a merge still holds its own old
     * copy of the words, which goes, and the withdrawn file's text becomes the heir's, so the section
     * counts copied below always match the stored text. Nothing about the heir changes before this. */
    const text = await m.KadeBookText.findOne({ book: row._id }, '_id').lean();
    if (text) {
      await m.KadeBookText.deleteOne({ book: next._id });
      await m.KadeBookText.updateOne({ _id: text._id }, { $set: { book: next._id } });
    }
    const keepsOwnText = !text && !!(await m.KadeBookText.findOne({ book: next._id }, '_id').lean());
    const shape = ['sections', 'skipped', 'stats', 'jacket', 'parserVersion'];
    const fields = ['kind', 'sections', 'skipped', 'stats', 'jacket', 'format', 'language', 'parserVersion', 'fileBytes', 'fileSha256', 'fileUrl', 'originalName']
      .filter((f) => !(keepsOwnText && shape.includes(f)));
    const set = Object.fromEntries(fields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]]));
    if (fileKeyOf(row)) set.fileKey = fileKeyOf(row);
    set.tracks = (row.tracks || []).map((t, i) => ({ ...t, title: ((next.tracks || [])[i] || {}).title || t.title }));
    if (row.grownUpsOnly && !next.grownUpsOnly) set.grownUpsOnly = true; // rule 8 outlives the withdrawal
    await KadeBook.updateOne({ _id: next._id }, { $set: set, $unset: { shortcutOf: 1 } });
    await KadeBook.updateMany({ shortcutOf: row._id, owner: row.owner }, { $set: { shortcutOf: next._id } });
    await KadeBook.updateMany({ mergedInto: row._id }, { $set: { mergedInto: next._id } });
    if (set.grownUpsOnly) await propagateGrownUps([next._id]);
    return next._id;
  }

  /** Shortcuts other people made to these rows. When a row is withdrawn they go with it: their owners
   * simply lose the pointer (their places and bookmarks on it too). */
  async function foreignShortcuts(rows) {
    const list = (rows || []).filter((r) => r && r._id);
    if (!list.length) return [];
    return (await KadeBook.find({ $or: list.map((r) => ({ shortcutOf: r._id, owner: { $ne: r.owner } })) }, '_id').lean()).map((r) => r._id);
  }

  /** Setting grown-ups on a file sets it on every shortcut to it, so a child's list never shows a
   * title they could not open. Clearing it leaves the shortcuts as their owners set them. */
  async function propagateGrownUps(ids) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return 0;
    const r = await KadeBook.updateMany({ shortcutOf: { $in: list }, grownUpsOnly: { $ne: true } }, { $set: { grownUpsOnly: true } });
    return (r && r.modifiedCount) || 0;
  }

  const FILE_FIELDS = '_id owner state shared grownUpsOnly kind tracks sections skipped stats jacket format language parserVersion fileBytes fileSha256 fileKey fileUrl originalName';
  /** A shortcut keeps its own name, folder, owner and sharing, and reads the file of the row it points
   * at (tracks with their descriptions, the text). It is never more open than that file. */
  async function withFile(row, reader) {
    if (!row || !row.shortcutOf) return row;
    const file = await KadeBook.findById(row.shortcutOf, FILE_FIELDS).lean();
    // A file taken down (its last part removed, or withdrawn) takes its shortcuts with it: the
    // shortcut's own old copy of the track list is never served.
    if (!file || file.state !== 'ready') return null;
    if (str(file.owner) !== str(row.owner) && !plan.canOpen(reader, file)) return null;
    if (reader && reader.child && file.grownUpsOnly) return null; // rule 8: simply absent
    const tracks = (file.tracks || []).map((t, i) => ({ ...t, title: ((row.tracks || [])[i] || {}).title || t.title }));
    return {
      ...row, kind: file.kind, tracks, sections: file.sections, skipped: file.skipped, stats: file.stats, jacket: file.jacket,
      format: file.format, language: file.language, parserVersion: file.parserVersion, fileUrl: file.fileUrl, fileKey: file.fileKey,
      originalName: file.originalName || row.originalName, fileId: file._id,
    };
  }

  /* ── the librarian's maintenance passes ─────────────────────────────────── */

  /** Every current object under a prefix, with size, ETag and date (ListObjectsV2, no egress). */
  async function listObjects(under) {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const out = [];
    let ContinuationToken;
    for (let page = 0; page < 2000; page++) {
      const r = await s3().send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: under, ContinuationToken, MaxKeys: 1000 }));
      for (const o of r.Contents || []) out.push({ key: o.Key, size: Number(o.Size) || 0, etag: cleanEtag(o.ETag), lastModified: o.LastModified });
      if (!r.IsTruncated) return out;
      ContinuationToken = r.NextContinuationToken;
    }
    throw new Error('the listing did not end');
  }

  /** Text rows older than `fileKey` learn it from their fileUrl (no storage call). */
  async function fillFileKeys({ apply = false } = {}) {
    const rows = await KadeBook.find({ fileUrl: { $gt: '' }, $or: [{ fileKey: '' }, { fileKey: { $exists: false } }] }, '_id fileUrl').lean();
    const ops = rows.map((r) => ({ id: r._id, key: keyFromFileUrl(r.fileUrl) })).filter((x) => x.key);
    if (apply && ops.length) {
      for (let i = 0; i < ops.length; i += 500) {
        await KadeBook.bulkWrite(ops.slice(i, i + 500).map((x) => ({ updateOne: { filter: { _id: x.id, $or: [{ fileKey: '' }, { fileKey: { $exists: false } }] }, update: { $set: { fileKey: x.key } } } })), { ordered: false });
      }
    }
    return { rows: rows.length, fileKeys: ops.length, written: apply ? ops.length : 0 };
  }

  /** POST /librarian/files/etags: fill tracks.etag from one listing pass (about 57 pages). */
  async function fillEtags({ apply = false, objects = null } = {}) {
    const listed = objects || (await listObjects(`${prefix()}/`));
    const byKey = new Map(listed.map((o) => [o.key, o]));
    const keys = [...byKey.keys()];
    let missing = 0;
    let written = 0;
    const sizeMismatch = [];
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      const rows = await KadeBook.find({ 'tracks.key': { $in: batch } }, '_id tracks.key tracks.etag tracks.bytes').lean();
      const need = new Set();
      for (const r of rows) {
        for (const t of r.tracks || []) {
          const o = t && byKey.get(t.key);
          if (!o) continue;
          if (Number(t.bytes) > 0 && Number(t.bytes) !== o.size && sizeMismatch.length < 50) sizeMismatch.push({ id: str(r._id), key: t.key, row: t.bytes, stored: o.size });
          if (!t.etag && o.etag) { missing++; need.add(t.key); }
        }
      }
      if (apply && need.size) {
        const ops = [...need].map((key) => ({ updateMany: { filter: { 'tracks.key': key }, update: { $set: { 'tracks.$[x].etag': byKey.get(key).etag } }, arrayFilters: [{ 'x.key': key, 'x.etag': { $in: ['', null] } }] } }));
        const r = await KadeBook.bulkWrite(ops, { ordered: false });
        written += (r && r.modifiedCount) || 0;
      }
    }
    const fileKeys = await fillFileKeys({ apply });
    return { listed: listed.length, gb: gb(listed.reduce((n, o) => n + o.size, 0)), tracksWithoutEtag: missing, written, sizeMismatch, fileKeys };
  }

  const ROW_FIELDS = '_id owner ownerName shared grownUpsOnly state path kind title author category tracks.key tracks.bytes tracks.sha256 tracks.etag tracks.title tracks.description.state librarian.state fileSha256 fileBytes fileKey fileUrl shortcutOf createdAt';

  async function usageOf(ids) {
    const usage = {};
    const bump = (id, field, n) => { const k = str(id); usage[k] = usage[k] || {}; usage[k][field] = (usage[k][field] || 0) + n; };
    if (!ids.length) return usage;
    const [readers, marks, lists, shortcuts] = await Promise.all([
      m.KadeReadingProgress.aggregate([{ $match: { book: { $in: ids } } }, { $group: { _id: '$book', n: { $sum: 1 } } }]),
      m.KadeReadingBookmark.aggregate([{ $match: { book: { $in: ids } } }, { $group: { _id: '$book', n: { $sum: 1 } } }]),
      m.KadeCollection.aggregate([{ $match: { 'items.book': { $in: ids } } }, { $unwind: '$items' }, { $match: { 'items.book': { $in: ids } } }, { $group: { _id: '$items.book', n: { $sum: 1 } } }]),
      KadeBook.aggregate([{ $match: { shortcutOf: { $in: ids }, state: 'ready' } }, { $group: { _id: '$shortcutOf', n: { $sum: 1 } } }]),
    ]);
    for (const r of readers) bump(r._id, 'readers', r.n);
    for (const r of marks) bump(r._id, 'bookmarks', r.n);
    for (const r of lists) bump(r._id, 'lists', r.n);
    for (const r of shortcuts) bump(r._id, 'shortcuts', r.n);
    return usage;
  }

  /** The key a row holds this file under (a track, or its original). */
  const keyIn = (row, sha256, bytes) => {
    const t = (row.tracks || []).find((x) => x && x.sha256 === sha256 && Number(x.bytes) === Number(bytes));
    if (t) return t.key || '';
    return row.fileSha256 === sha256 && Number(row.fileBytes) === Number(bytes) ? fileKeyOf(row) : '';
  };

  /**
   * Groups of ready rows holding one file, where the library really stores it twice (two or more
   * stored objects) or two of one owner's own rows share it without being a shortcut (held pairs).
   * Groups whose rows are the same set of rows (an audiobook's clips) are shown once, with `files`.
   * @param {{ only?: Array<{ sha256: string, bytes: number }> }} [options]
   */
  async function loadGroups({ only = null } = {}) {
    const pick = only ? { $or: only.map((g) => ({ sha256: g.sha256, bytes: g.bytes })) } : null;
    const tracks = await KadeBook.aggregate([
      { $match: { state: 'ready', ...(only ? { $or: only.map((g) => ({ tracks: { $elemMatch: { sha256: g.sha256, bytes: g.bytes } } })) } : { 'tracks.sha256': { $gt: '' } }) } },
      { $unwind: '$tracks' },
      { $project: { sha256: '$tracks.sha256', bytes: '$tracks.bytes' } },
      { $match: pick || { sha256: { $gt: '' }, bytes: { $gt: 0 } } },
      { $group: { _id: { sha256: '$sha256', bytes: '$bytes' }, rows: { $addToSet: '$_id' } } },
      { $match: { 'rows.1': { $exists: true } } },
    ]).allowDiskUse(true);
    const originals = await KadeBook.aggregate([
      { $match: { state: 'ready', kind: 'text', ...(only ? { $or: only.map((g) => ({ fileSha256: g.sha256, fileBytes: g.bytes })) } : { fileSha256: { $gt: '' }, fileBytes: { $gt: 0 } }) } },
      { $group: { _id: { sha256: '$fileSha256', bytes: '$fileBytes' }, rows: { $addToSet: '$_id' } } },
      { $match: { 'rows.1': { $exists: true } } },
    ]).allowDiskUse(true);
    const raw = [...tracks, ...originals].filter((g) => plan.SHA256.test(str(g._id.sha256)) && Number(g._id.bytes) > 0);
    const ids = [...new Set(raw.flatMap((g) => g.rows.map(str)))];
    const rows = new Map();
    for (let i = 0; i < ids.length; i += 1000) {
      for (const r of await KadeBook.find({ _id: { $in: ids.slice(i, i + 1000) }, state: 'ready' }, ROW_FIELDS).lean()) rows.set(str(r._id), r);
    }
    const out = new Map();
    for (const g of raw) {
      const { sha256, bytes } = g._id;
      const members = g.rows.map((id) => rows.get(str(id))).filter(Boolean);
      const items = members.filter((r) => !r.shortcutOf);
      if (items.length < 2) continue;
      const keys = items.map((r) => keyIn(r, sha256, bytes));
      const stored = new Set(keys.filter(Boolean)).size;
      const shared = items.some((r, i) => keys[i] && items.some((o, j) => j !== i && keys[j] === keys[i] && str(o.owner) === str(r.owner)));
      if (stored < 2 && !shared) continue;
      const set = items.map((r) => str(r._id)).sort().join(',');
      const known = out.get(set);
      if (known) { known.files += 1; if (plan.groupId(sha256, bytes) < known.id) Object.assign(known, { id: plan.groupId(sha256, bytes), sha256, bytes }); continue; }
      out.set(set, { id: plan.groupId(sha256, bytes), sha256, bytes, files: 1, items, keys: Object.fromEntries(items.map((r, i) => [str(r._id), keys[i]])) });
    }
    const groups = [...out.values()];
    const usage = await usageOf([...new Set(groups.flatMap((g) => g.items.map((r) => r._id)))]);
    for (const g of groups) g.usage = usage;
    return groups;
  }

  const rowView = (r, g, extra) => ({
    id: str(r._id), title: r.title, path: r.path || '', where: where(r), kind: r.kind, owner: str(r.owner), ownerName: r.ownerName || '',
    shared: !!r.shared, grownUpsOnly: !!r.grownUpsOnly, key: (g.keys || {})[str(r._id)] || '', usage: (g.usage || {})[str(r._id)] || {},
    action: extra ? extra.action : 'keep', why: extra ? extra.why : 'the copy that stays',
  });
  function describeGroup(g, p) {
    const byId = new Map(p.extras.map((e) => [e.id, e]));
    return {
      id: g.id, sha256: g.sha256, bytes: g.bytes, files: g.files, keeper: p.keeper, hold: p.hold, keeperSet: p.keeperSet,
      rows: g.items.map((r) => rowView(r, g, str(r._id) === p.keeper ? null : byId.get(str(r._id)))),
    };
  }

  /** GET /librarian/duplicates: every group with its plan and usage counts (nothing written). */
  async function duplicateGroups() {
    const groups = await loadGroups();
    const out = [];
    for (const g of groups) {
      const p = plan.planGroup(g.items, { usage: g.usage });
      if (p) out.push(describeGroup(g, p));
    }
    out.sort((a, b) => (a.hold ? 1 : 0) - (b.hold ? 1 : 0) || (a.id < b.id ? -1 : 1));
    return out;
  }

  const actionOf = (v) => (v === 'merge' || v === 'shortcut' ? v : null);
  /** Kade's explicit plan for a held group: { keeper, action } or { keeper, actions: { id: action } }. */
  function explicitPlan(given, g) {
    if (!given || typeof given !== 'object') return null;
    const keeperId = str(given.keeper);
    if (!g.items.some((r) => str(r._id) === keeperId)) return { error: 'the chosen keeper is not in this group' };
    const actions = {};
    for (const r of g.items) {
      const id = str(r._id);
      if (id === keeperId) continue;
      const a = actionOf((given.actions && given.actions[id]) || given.action);
      if ((given.actions && given.actions[id]) || given.action) {
        if (!a) return { error: 'an action must be merge or shortcut' };
        actions[id] = a;
      }
    }
    return { keeperId, actions };
  }

  /**
   * POST /librarian/duplicates/merge. Re-plans every group from the database (never the page's copy
   * of the plan), refuses a group whose keeper changed since the preview, applies a held group only
   * when it is listed in confirmHeld (with Kade's own plan for it, if she gave one), and writes one
   * receipt per group so it can be undone for 30 days.
   */
  async function mergeGroups({ groups = 'all', keepers = {}, confirmHeld = [], plans = {}, apply = false, limit = 300, by = '' } = {}) {
    const wanted = groups === 'all' ? null : (Array.isArray(groups) ? groups : []).map(plan.parseGroupId).filter(Boolean);
    if (wanted && !wanted.length) return { applied: [], refused: [], preview: [], more: false };
    const loaded = await loadGroups({ only: wanted });
    const confirmed = new Set((Array.isArray(confirmHeld) ? confirmHeld : []).map(str));
    const result = { applied: [], refused: [], preview: [], more: false };
    let done = 0;
    for (const g of loaded) {
      if (wanted && !wanted.some((w) => plan.groupId(w.sha256, w.bytes) === g.id)) continue;
      const first = plan.planGroup(g.items, { usage: g.usage });
      if (!first) continue;
      let p = first;
      if (first.hold) {
        if (!confirmed.has(g.id)) { result.refused.push({ group: g.id, why: `held: ${first.hold}; list it in confirmHeld to apply it` }); continue; }
        const explicit = explicitPlan(plans && plans[g.id], g);
        if (explicit && explicit.error) { result.refused.push({ group: g.id, why: explicit.error }); continue; }
        if (explicit) p = plan.planGroup(g.items, { usage: g.usage, keeperId: explicit.keeperId, actions: explicit.actions });
      }
      if (p.unsafe) { result.refused.push({ group: g.id, why: `refused: ${p.unsafe}` }); continue; }
      if (keepers && keepers[g.id] && str(keepers[g.id]) !== p.keeper) {
        result.refused.push({ group: g.id, why: 'the keeper changed since the preview; look at the list again', keeper: p.keeper });
        continue;
      }
      if (!apply) { result.preview.push(describeGroup(g, p)); continue; }
      if (done >= limit) { result.more = true; break; }
      done++;
      const keeperRow = await KadeBook.findById(p.keeper).lean();
      if (!keeperRow || keeperRow.state !== 'ready') { result.refused.push({ group: g.id, why: 'the keeper is gone' }); continue; }
      const entries = [];
      // The keeper's share of the others (the stricter grown-ups flag) goes with the first fold that
      // really changes a row of its owner; a link to another person's row carries nothing over.
      let keeperSet = p.keeperSet || {};
      for (const e of p.extras) {
        const keeper = await KadeBook.findById(p.keeper).lean();
        const extra = await KadeBook.findById(e.id).lean();
        if (!keeper || !extra || extra.state !== 'ready') { entries.push({ id: e.id, action: 'skipped', why: 'the row changed or went since it was read' }); continue; }
        const entry = await foldInto(keeper, extra, e.action, keeperSet);
        entries.push(entry);
        if (entry.action === 'merge' || entry.action === 'shortcut') keeperSet = {};
      }
      const tookGrownUps = !!(p.keeperSet && p.keeperSet.grownUpsOnly) && Object.keys(keeperSet).length === 0;
      /* A grown-ups file takes every shortcut to it along (rule 8): the ones it had, the ones a merged
       * copy brought with it, and the ones this merge made. The receipt names them, so an undo opens
       * them again. */
      const keeperNow = await KadeBook.findById(keeperRow._id, 'grownUpsOnly').lean();
      const propagated = keeperNow && keeperNow.grownUpsOnly
        ? (await KadeBook.find({ shortcutOf: keeperRow._id, grownUpsOnly: { $ne: true } }, '_id').lean()).map((r) => r._id)
        : [];
      if (propagated.length) await KadeBook.updateMany({ _id: { $in: propagated } }, { $set: { grownUpsOnly: true } });
      const receipt = m.Receipts
        ? await m.Receipts.create({ kind: 'file', group: g.id, keeper: keeperRow._id, entries, keeperBefore: { grownUpsOnly: !!keeperRow.grownUpsOnly, keeperSet: tookGrownUps ? p.keeperSet : {}, propagated }, by })
        : null;
      log(`[library/files] merged group ${g.id}: kept ${p.keeper}, ${entries.map((x) => `${x.id} ${x.action}`).join(', ')}`);
      result.applied.push({ group: g.id, keeper: p.keeper, receipt: receipt ? str(receipt._id) : '', entries: entries.map((x) => ({ id: x.id, action: x.action, why: x.why || '', released: (x.released || []).length })) });
    }
    return result;
  }

  /** POST /librarian/duplicates/undo: put folds back, newest first, inside the 30 days. */
  async function undoReceipts({ receiptIds = [], all = false } = {}) {
    if (!m.Receipts) return { undone: [] };
    const ids = (Array.isArray(receiptIds) ? receiptIds : []).map(str).filter((id) => /^[a-f0-9]{24}$/i.test(id));
    if (!all && !ids.length) return { undone: [] };
    const since = new Date(Date.now() - TOMBSTONE_DAYS * DAY);
    const receipts = await m.Receipts.find({ undoneAt: { $exists: false }, createdAt: { $gte: since }, ...(all ? {} : { _id: { $in: ids } }) }).sort({ createdAt: -1 }).limit(2000).lean();
    const undone = [];
    for (const r of receipts) {
      const claimed = await m.Receipts.updateOne({ _id: r._id, undoneAt: { $exists: false } }, { $set: { undoneAt: new Date() } });
      if (!claimed.modifiedCount) continue;
      for (const e of [...(r.entries || [])].reverse()) {
        if (['merge', 'shortcut'].includes(e.action)) await undoFold(e, r.keeper);
      }
      const kb = r.keeperBefore || {};
      if (kb.keeperSet && kb.keeperSet.grownUpsOnly && kb.grownUpsOnly === false) {
        await KadeBook.updateOne({ _id: r.keeper, grownUpsOnly: true }, { $set: { grownUpsOnly: false } });
      }
      if (Array.isArray(kb.propagated) && kb.propagated.length) await KadeBook.updateMany({ _id: { $in: kb.propagated }, grownUpsOnly: true }, { $set: { grownUpsOnly: false } });
      undone.push({ receipt: str(r._id), group: r.group, keeper: str(r.keeper), rows: (r.entries || []).filter((e) => ['merge', 'shortcut'].includes(e.action)).map((e) => e.id) });
    }
    return { undone };
  }

  /**
   * POST /librarian/books/merge: Bookshare re-downloads (the same text in a different ZIP, Amber's
   * batch of Sep 25). A pair folds only when both rows are ready text books of one owner with the
   * same section count and the same words (bookTextDigest, jacket excluded). Readers' places and
   * bookmarks carry over; the extra is hidden and forwards for 30 days (undo through
   * /librarian/duplicates/undo). Any pair that is not identical is refused and named.
   */
  async function mergeBooks({ pairs = [], apply = false, by = '' } = {}) {
    const out = { ok: [], refused: [], applied: [] };
    const seen = new Set();
    for (const pair of (Array.isArray(pairs) ? pairs : []).slice(0, 500)) {
      const extraId = str(pair && pair.extra);
      const keeperId = str(pair && pair.keeper);
      const refuse = (why) => out.refused.push({ extra: extraId, keeper: keeperId, why });
      if (!/^[a-f0-9]{24}$/i.test(extraId) || !/^[a-f0-9]{24}$/i.test(keeperId)) { refuse('not a pair of item ids'); continue; }
      if (extraId === keeperId) { refuse('the same item twice'); continue; }
      if (seen.has(extraId)) { refuse('this extra is already in the list'); continue; }
      seen.add(extraId);
      const [E, K] = await Promise.all([KadeBook.findById(extraId).lean(), KadeBook.findById(keeperId).lean()]);
      if (!E || !K) { refuse('one of the two is not in the library'); continue; }
      if (E.kind !== 'text' || K.kind !== 'text') { refuse('both must be text books'); continue; }
      if (E.state !== 'ready' || K.state !== 'ready') { refuse('both must be ready'); continue; }
      if (str(E.owner) !== str(K.owner)) { refuse("different owners: another person's book is never folded away"); continue; }
      if (E.shortcutOf || K.shortcutOf) { refuse('one of the two is a shortcut'); continue; }
      // Its readers and old links would move onto a book the family cannot open.
      if (E.shared && !K.shared) { refuse('the extra is in the family library and the keeper is private: keep the shared one'); continue; }
      if ((E.sections || []).length !== (K.sections || []).length) { refuse(`different section counts (${(E.sections || []).length} and ${(K.sections || []).length})`); continue; }
      const [te, tk] = await Promise.all([m.KadeBookText.findOne({ book: E._id }).lean(), m.KadeBookText.findOne({ book: K._id }).lean()]);
      if (!te || !tk) { refuse('the text of one of the two is missing'); continue; }
      const de = plan.bookTextDigest(te.sections, (E.sections || []).map((s) => s.kind));
      const dk = plan.bookTextDigest(tk.sections, (K.sections || []).map((s) => s.kind));
      if (de !== dk) { refuse('the text differs'); continue; }
      const view = { extra: extraId, keeper: keeperId, title: K.title, extraTitle: E.title, path: K.path || '', extraPath: E.path || '' };
      if (!apply) { out.ok.push(view); continue; }
      const keeperSet = E.grownUpsOnly && !K.grownUpsOnly ? { grownUpsOnly: true } : {};
      const entry = await foldInto(K, E, 'merge', keeperSet, { whole: true, keepOwnFiles: true, sameText: true });
      if (entry.action !== 'merge') { refuse(entry.why || 'the row changed since it was read'); continue; }
      const receipt = m.Receipts
        ? await m.Receipts.create({ kind: 'text', group: `text:${extraId}`, keeper: K._id, entries: [entry], keeperBefore: { grownUpsOnly: !!K.grownUpsOnly, keeperSet }, by })
        : null;
      log(`[library/files] same-text book ${extraId} folded into ${keeperId}`);
      out.applied.push({ ...view, receipt: receipt ? str(receipt._id) : '', readers: (entry.refs.progress || []).length, bookmarks: (entry.refs.bookmarks || []).length });
    }
    return out;
  }

  /**
   * POST /librarian/files/unreferenced. Reports objects under media-library/<id>/ that no row lists;
   * with apply, deletes only those byte-identical to a key the same item lists and older than a day
   * (plan.classifyUnreferenced), each re-checked as unreferenced just before it goes. Book originals
   * nothing lists are reported, never deleted.
   */
  async function unreferenced({ apply = false, objects = null, books = null } = {}) {
    const listed = objects || (await listObjects(`${prefix()}/`));
    const report = await unreferencedIn(KadeBook, listed);
    const deleted = [];
    if (apply) {
      const goes = [];
      for (const e of report.entries.filter((x) => x.deletable)) {
        const used = await KadeBook.exists({ $or: [{ 'tracks.key': e.key }, { fileKey: e.key }] });
        if (!used) goes.push(e.key);
      }
      for (let i = 0; i < goes.length; i += 200) await deleteKeys(goes.slice(i, i + 200));
      deleted.push(...goes);
      if (goes.length) log(`[library/files] removed ${goes.length} unreferenced byte-identical copies`);
    }
    let bookReport = null;
    const originals = books || (objects ? null : await listObjects('books/').catch(() => null));
    if (originals) {
      const rows = await KadeBook.find({ $or: [{ fileKey: { $gt: '' } }, { fileUrl: { $gt: '' } }] }, 'fileKey fileUrl').lean();
      const known = new Set(rows.map((r) => fileKeyOf(r)).filter(Boolean));
      const loose = originals.filter((o) => !known.has(o.key));
      bookReport = { listed: originals.length, count: loose.length, gb: gb(loose.reduce((n, o) => n + o.size, 0)), sample: loose.slice(0, 50).map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified })) };
    }
    const { entries, ...totals } = report;
    return {
      ...totals,
      deleted: deleted.length,
      deletedGb: gb(entries.filter((e) => deleted.includes(e.key)).reduce((n, e) => n + e.size, 0)),
      entries: entries.slice(0, 500),
      books: bookReport,
    };
  }

  return {
    sha256Of, hashKey, hashFileKey, holders, storedTwin, releaseKeys, stillThere, repoint, foldInto, undoFold,
    settleNewCopy, verifyItem, verifyPass, hashCollisions, purgeTombstones, promoteShortcuts, foreignShortcuts, propagateGrownUps, withFile,
    listObjects, fillFileKeys, fillEtags, loadGroups, duplicateGroups, mergeGroups, undoReceipts, mergeBooks, unreferenced,
    budget: () => ({ day: today(), gbRead: gb(spentToday()), bytesRead: spentToday(), dailyGb: gb(DAILY_BYTES()) }),
    MODE,
  };
}

/** Where a row's file lives: itself, or the row a shortcut reads. */
const fileIdOf = (book) => (book && (book.fileId || book._id));

module.exports = { createLibraryFiles, unreferencedIn, sha256OfStream, sha256OfFile, sha256OfBuffer, hashingStream, fileIdOf, cleanEtag, MODE, DAILY_BYTES, TOMBSTONE_DAYS };
