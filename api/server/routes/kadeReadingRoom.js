/* ----------------------------------------------------------------------------
 * THE READING ROOM — routes (Part 181, Sep 11 2026)
 *
 * Her ask, in her words: a reading room where Bookshare books (DAISY zips by
 * default, EPUB on request) are read aloud by the Inworld voices a chunk at a
 * time, with rewind, forward, bookmarks and chapter navigation; the Bookshare
 * watermark skipped; an opening like an NLS cartridge (jacket, useful facts,
 * then the story); a private shelf per person, a public library anyone can
 * donate to ("Donated by Amber") and check books out of; web AND native, with
 * the iPhone share sheet as the way a book gets in.
 *
 * Mounted at /api/kade/reading-room, every route requireJwtAuth.
 *
 *   GET    /shelf                       my books, what I'm reading, the library
 *   POST   /upload                      multipart field `book` (zip/epub/txt/docx/html)
 *   GET    /book/:id                    jacket, chapters, skipped list, my progress, bookmarks
 *   GET    /book/:id/text/:s/:c         one chunk's words (+ prev/next positions)
 *   GET    /book/:id/passages/:s        a reading-view page: ?from=&count= chunks, cleaned for the screen
 *   GET    /book/:id/audio/:s/:c        that chunk spoken — WAV, streamed from the proxy
 *   POST   /book/:id/progress           { s, c, voice, speed, finished }
 *   GET    /book/:id/bookmarks
 *   POST   /book/:id/bookmarks          { s, c, note }
 *   DELETE /book/:id/bookmarks/:bid
 *   POST   /book/:id/share              { shared, grownUpsOnly }  (owner)
 *   POST   /book/:id/return             take a library book off my shelf
 *   DELETE /book/:id                    withdraw a book (owner or ADMIN)
 *
 * AUDIO: nothing is cached on purpose. Every chunk is <= ~450 characters so
 * the proxy's streamed lane answers in under half a second, the reader is
 * charged nothing (Inworld plan characters, logged to kadeusage as `tts` so
 * /usage-dashboard sees the ceiling), and ten hours of WAV never lands on B2.
 * The x-kade-tts-session header carries `reading:<user>:<book>` so the proxy
 * gives each chunk the previous one as intonation context — that is what
 * keeps a book from sounding like a pile of unrelated sentences.
 *
 * CHILD ACCOUNTS: a `grownUpsOnly` book is simply absent from a child's
 * library and shelf lists and its routes answer 404 — never "you can't"
 * (rule 8: a child account is never told it is filtered).
 * -------------------------------------------------------------------------- */
const axios = require('axios');
const { createHash } = require('node:crypto');
const multer = require('multer');
const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { descriptionBatchRouter, bookImportRouter, saveBufferToS3, openAudioArchive, AUDIO_ZIP_LIMIT, TEXT_IMPORT_LIMIT, storeAudioStream, libraryPath, libraryCategory, libraryPathExpression, refineMediaFiling, correctedBookShelf, reviewedLibraryMoves } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { tubeVaultHints, validTubeVaultItems } = require('@librechat/api');
const { logKadeUsage } = require('~/models/kadeUsage');
const { KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection, KadeLibraryFold, CATEGORIES } = require('~/models/kadeBook');
const { parseBook, PARSER_VERSION, NOTICE_REASONS } = require('./kadeReadingRoomParse');

/* ── the media library on B2 (Part 181 continued) ──────────────────────────
 * Audio donations do not pass through this server: the phone or the browser
 * asks for a signed PUT, sends the bytes straight to the bucket, and reports
 * back. A 700 MB movie soundtrack never sits in Railway memory. The bucket is
 * the one the platform already uses (the B2 key is scoped to that bucket
 * alone), under the `media-library/` prefix; `KADE_MEDIA_BUCKET` moves it to
 * its own bucket the day a key for one exists. Storage is ~$6 a TB a month,
 * so the whole family library is pennies.
 *
 * Browser uploads need a CORS rule on the bucket allowing PUT from
 * https://kademurdock.com; the phone needs nothing. Until the rule exists
 * the web page falls back to the 80 MB through-the-server lane. */
const MEDIA_PREFIX = () => process.env.KADE_MEDIA_PREFIX || 'media-library';
const MEDIA_BUCKET = () => process.env.KADE_MEDIA_BUCKET || process.env.AWS_BUCKET_NAME || '';
const MAX_TRACK_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB a track (multipart above 4 GB)
const AUDIO_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', aiff: 'audio/aiff', aif: 'audio/aiff', wma: 'audio/x-ms-wma' };
/** Video, for the archive. MKV is not a browser format: the push tool remuxes
 * it to MP4 before it leaves her drive. WebM plays in Chrome and on iOS 17+. */
const VIDEO_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };
const MEDIA_EXT = Object.assign({}, AUDIO_EXT, VIDEO_EXT);
/* Part 282 (Sep 23 2026): only a real media extension comes off an upload's title, with the
 * download leftovers a pushed file name can carry: yt-dlp's stream tag (".f136"), its ".temp" and
 * ".part" files, and an inner video extension ("LSU ads 1989.wmv.mp4"). Stripping "everything after
 * the last period" had cut 870 titles since Sep 19: "1996 Chuck E. Cheese's commercial" arrived as
 * "1996 Chuck E", "St. Louis" as "St", "Mr. Holland's Opus" as "Mr", and the librarian could not
 * file what it could not read. */
const bareTitle = (s) => String(s)
  .replace(/\.([A-Za-z0-9]{2,5})$/, (whole, ext) => (MEDIA_EXT[ext.toLowerCase()] ? '' : whole))
  .replace(/(?:\.(?:f\d{2,4}|temp|part|ytdl|wmv|avi|mkv|flv|mpe?g|3gp|vob))+$/i, '');
const mimeFor = (name, hint) => {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (MEDIA_EXT[ext]) return { ext, mime: MEDIA_EXT[ext], kind: VIDEO_EXT[ext] ? 'video' : 'audio' };
  const h = String(hint || '');
  if (h.startsWith('video/')) return { ext: 'mp4', mime: h.slice(0, 60), kind: 'video' };
  if (h.startsWith('audio/')) return { ext: 'mp3', mime: h.slice(0, 60), kind: 'audio' };
  return null;
};
/* Measured Sep 12 2026 from her PC: Backblaze takes about 1 MB/s PER CONNECTION and scales
 * almost linearly with connections (10 → 9.5 MB/s). So anything over 150 MB goes up in
 * 50 MB parts the tool sends several at a time; a 1.4 GB movie is minutes, not twenty. */
const MULTIPART_PART_BYTES = 50 * 1024 * 1024;
const MULTIPART_ABOVE = 150 * 1024 * 1024;
let _s3 = null;
function s3() {
  if (_s3) return _s3;
  try {
    const { initializeS3 } = require('@librechat/api');
    _s3 = typeof initializeS3 === 'function' ? initializeS3() : null;
  } catch (e) {
    logger.warn(`[reading-room] S3 client unavailable: ${e.message}`);
    _s3 = null;
  }
  return _s3;
}
async function signPut(key, contentType, bytes) {
  const client = s3();
  if (!client || !MEDIA_BUCKET()) throw new Error('media storage is not configured');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new PutObjectCommand({ Bucket: MEDIA_BUCKET(), Key: key, ContentType: contentType, ...(bytes ? { ContentLength: bytes } : {}) });
  return getSignedUrl(client, cmd, { expiresIn: 3 * 3600 });
}
async function signGet(key, contentType) {
  const client = s3();
  if (!client || !MEDIA_BUCKET()) throw new Error('media storage is not configured');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const cmd = new GetObjectCommand({ Bucket: MEDIA_BUCKET(), Key: key, ...(contentType ? { ResponseContentType: contentType } : {}) });
  return getSignedUrl(client, cmd, { expiresIn: 12 * 3600 });
}
async function headObject(key) {
  const client = s3();
  const { HeadObjectCommand } = require('@aws-sdk/client-s3');
  return client.send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET(), Key: key }));
}
async function putBuffer(key, buffer, contentType) {
  const client = s3();
  if (!client || !MEDIA_BUCKET()) throw new Error('media storage is not configured');
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await client.send(new PutObjectCommand({ Bucket: MEDIA_BUCKET(), Key: key, Body: buffer, ContentType: contentType }));
}
async function getBuffer(key) {
  const client = s3();
  if (!client || !MEDIA_BUCKET()) throw new Error('media storage is not configured');
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const out = await client.send(new GetObjectCommand({ Bucket: MEDIA_BUCKET(), Key: key }));
  if (out.Body && typeof out.Body.transformToByteArray === 'function') return Buffer.from(await out.Body.transformToByteArray());
  const parts = [];
  for await (const chunk of out.Body) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(parts);
}
/** The stored original's key, from the URL saveBufferToS3 handed back
 * (".../books/<user>/book-....zip", presigned or not). */
function keyFromFileUrl(fileUrl) {
  try {
    const path = decodeURIComponent(new URL(String(fileUrl)).pathname);
    const i = path.indexOf('/books/');
    return i === -1 ? '' : path.slice(i + 1);
  } catch (e) {
    return '';
  }
}

/* ── re-read a book with a newer parser ─────────────────────────────────
 * Sep 12 2026, her Narnia omnibus: the parser that cut it saw three sections
 * for seven books, so "next chapter" jumped a whole book. The parser learned
 * the shape (kadeReadingRoomParse.js PARSER_VERSION 2); every text book cut
 * by an older parser is re-read from its stored original the next time
 * anyone opens it. Progress rows and bookmarks are carried over by their
 * flat chunk index, so a reader lands within a chunk of where they were.
 * Fail-soft: a book whose original is missing or unreadable keeps its old
 * sections and is stamped so it is not retried on every open. */
const reparsing = new Set();
async function reparseIfStale(book) {
  if (!book || book.kind !== 'text' || (book.parserVersion || 1) >= PARSER_VERSION) return book;
  /* Sep 25 2026: a shortcut reads its keeper's text, so the keeper is re-read once and every
   * shortcut to it takes the new cut (and its readers' places). */
  const fileId = book.fileId || book._id;
  const id = String(fileId);
  if (reparsing.has(id)) return book;
  reparsing.add(id);
  const t0 = Date.now();
  try {
    const key = book.fileKey || keyFromFileUrl(book.fileUrl);
    if (!key) {
      await KadeBook.updateMany({ $or: [{ _id: fileId }, { shortcutOf: fileId }] }, { $set: { parserVersion: PARSER_VERSION } });
      logger.info(`[reading-room/reparse] book=${id} "${book.title}" has no stored original; kept as cut`);
      return book;
    }
    const buffer = await getBuffer(key);
    const parsed = await parseBook(buffer, book.originalName || key.split('/').pop() || 'book');
    if (!parsed.sections.length || parsed.stats.chars < 200) throw new Error('re-read found no text');
    const oldCounts = (book.sections || []).map((x) => x.chunkCount || 0);
    const newCounts = parsed.sections.map((x) => x.chunks.length);
    const flat = (counts, s, c) => counts.slice(0, s).reduce((n, k) => n + k, 0) + c;
    const unflat = (counts, f) => {
      let left = Math.max(0, f);
      for (let i = 0; i < counts.length; i++) {
        if (left < counts[i]) return { s: i, c: left };
        left -= counts[i];
      }
      const last = Math.max(0, counts.length - 1);
      return { s: last, c: Math.max(0, (counts[last] || 1) - 1) };
    };
    await KadeBookText.updateOne({ book: fileId }, { $set: { sections: parsed.sections.map((x) => ({ chunks: x.chunks })), skipped: parsed.skipped.map((x) => ({ chunks: x.chunks })) } }, { upsert: true });
    const set = {
      parserVersion: PARSER_VERSION,
      jacket: parsed.jacket,
      sections: parsed.sections.map((x) => ({ title: x.title, chunkCount: x.chunks.length, chars: x.chars, kind: x.kind })),
      skipped: parsed.skipped.map((x) => ({ title: x.title, reason: x.reason, chunkCount: x.chunks.length, chars: x.chars })),
      stats: { chunks: parsed.stats.chunks, chars: parsed.stats.chars, listen: parsed.stats.listen },
    };
    await KadeBook.updateOne({ _id: fileId }, { $set: set });
    const shortcutIds = (await KadeBook.find({ shortcutOf: fileId }, '_id').lean()).map((r) => r._id);
    if (shortcutIds.length) await KadeBook.updateMany({ _id: { $in: shortcutIds } }, { $set: set });
    const readers = { $in: [fileId, ...shortcutIds] };
    const rows = await KadeReadingProgress.find({ book: readers }).lean();
    for (const r of rows) {
      const to = unflat(newCounts, flat(oldCounts, r.s || 0, r.c || 0));
      await KadeReadingProgress.updateOne({ _id: r._id }, { $set: { s: to.s, c: to.c } });
    }
    const marks = await KadeReadingBookmark.find({ book: readers }).lean();
    for (const m of marks) {
      const to = unflat(newCounts, flat(oldCounts, m.s || 0, m.c || 0));
      await KadeReadingBookmark.updateOne({ _id: m._id }, { $set: { s: to.s, c: to.c } });
    }
    logger.info(`[reading-room/reparse] book=${id} "${book.title}" v${book.parserVersion || 1} -> v${PARSER_VERSION}: ${oldCounts.length} -> ${newCounts.length} sections, ${parsed.stats.chunks} chunks, ${rows.length} progress row(s) and ${marks.length} bookmark(s) carried, ${Date.now() - t0}ms`);
    return Object.assign({}, book, set);
  } catch (e) {
    logger.warn(`[reading-room/reparse] book=${id} "${book.title}" failed (${e.message}); kept as cut`);
    await KadeBook.updateMany({ $or: [{ _id: fileId }, { shortcutOf: fileId }] }, { $set: { parserVersion: PARSER_VERSION } }).catch(() => {});
    return book;
  } finally {
    reparsing.delete(id);
  }
}

async function deleteKeys(keys) {
  const client = s3();
  if (!client || !keys.length) return;
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  for (const k of keys) {
    try { await client.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET(), Key: k })); } catch (e) { logger.warn(`[reading-room] could not delete ${k}: ${e.message}`); }
  }
}
const trackKey = (bookId, ext) => `${MEDIA_PREFIX()}/${bookId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

/** Accounts that must see an EMPTY family library: the App Store reviewer's
 * seat (and anything else in KADE_LIBRARY_HIDDEN_FROM), test seats, and every
 * account Kade has not given family library access (Sep 24 2026, see
 * packages/api library/access.ts). The shared shelf and everyone else's items
 * are simply absent for them; their own uploads work as before. */
function libraryHiddenFrom(req) {
  return !require('@librechat/api').familyLibraryMember(req.user);
}
function listenClock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (!h) return `${m} minute${m === 1 ? '' : 's'}`;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` and ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}
function refreshListen(item) {
  const seconds = item.tracks.reduce((n, t) => n + (t.seconds || 0), 0);
  item.stats = item.stats || {};
  item.stats.listen = seconds ? listenClock(seconds) : `${item.tracks.length} ${item.tracks.length === 1 ? 'recording' : 'recordings'}`;
}

const router = express.Router();
router.get('/guide', requireJwtAuth, (_req, res) => res.json(require('@librechat/api').librarianGuide));
const { requests: libraryRequests, requestReader } = require('~/server/services/kadeLibraryRequests');
router.use('/requests', express.json({ limit: '12kb' }), require('@librechat/api').libraryRequestRouter(
  libraryRequests, requireJwtAuth, (req) => requestReader(req.user?.id),
));

/* ── THE ONE-FILE RULE (Sep 25 2026) ──────────────────────────────────────
 * Kade: "I need this to be a safeguard for dupes on all library media, where like, it HAS to be the
 * exact same file for a dupe flag, and then it only keeps one of them. If there was some reason a
 * file needed to be in multiple collections, it can be a shortcut to the same file."
 * Same file = same byte count and the same SHA-256, computed here from the stored bytes. The rules
 * are in services/kadeLibraryFilesPlan.js, the storage side in services/kadeLibraryFiles.js.
 * KADE_LIBRARY_FILES: report (default: hash and flag), on (a new copy is kept once), off. */
const { createLibraryFiles, sha256OfFile, sha256OfBuffer, MODE: filesMode } = require('~/server/services/kadeLibraryFiles');
const filesPlan = require('~/server/services/kadeLibraryFilesPlan');
const { opsOrAdmin } = require('~/server/middleware/kadeOpsSecret');
/** The reader shape the one-file rule asks "could they open it?" with (as requestReader returns). */
const readerFor = async (req) => ({ id: String(req.user.id), admin: isAdmin(req), child: await isChild(req), hidden: libraryHiddenFrom(req) });
/** New stored bytes wait for the verifier (every 2 minutes), unless the rule is off. */
const pendingCheck = () => (filesMode() === 'off' ? {} : { fileCheck: { state: 'pending', at: new Date() } });
const libraryFiles = createLibraryFiles({
  models: {
    KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection, Receipts: KadeLibraryFold,
    get KadeLibrarySubmission() { return require('~/models/kadeBook').KadeLibrarySubmission; },
    get Requests() { return mongoose.models.KadeMediaRequest; },
    get DescriptionJobs() { return mongoose.models.KadeDescriptionJob; },
  },
  s3, bucket: MEDIA_BUCKET, deleteKeys, readerOf: requestReader, keyFromFileUrl, prefix: MEDIA_PREFIX,
  notify: (id, text) => notifyUser(id, text), where: (row) => libraryPath(row), log: (message) => logger.info(message),
});
/** "Already in the library: ..." for a stored copy this reader can open (never any other). */
const alreadyAnswer = (req, twin, same = 'file') => ({
  ok: true, duplicate: true, same,
  book: summary(twin, null), skipped: twin.skipped || [], jacket: twin.jacket || '',
  message: same === 'file'
    ? filesPlan.alreadyLine(twin, twin.shared ? libraryPath(twin) : '', { own: String(twin.owner) === String(req.user.id) && !twin.shared })
    : `Already in the library: "${twin.title}"${twin.author ? ` by ${twin.author}` : ''}. It has exactly the same text, so nothing new was added.`,
});
/** A row older than `fileKey` names its stored original only in fileUrl: write the key on it before
 * another row shares that original, so reference counting sees both rows (releaseKeys also reads
 * fileUrl, and POST /librarian/files/etags fills every row). Returns the key. */
async function ensureFileKey(row) {
  const key = (row && (row.fileKey || keyFromFileUrl(row.fileUrl))) || '';
  if (key && !row.fileKey) {
    await KadeBook.updateOne({ _id: row._id, $or: [{ fileKey: '' }, { fileKey: { $exists: false } }] }, { $set: { fileKey: key } })
      .catch((e) => logger.warn(`[library/files] fileKey not written on ${row._id}: ${e.message}`));
  }
  return key;
}

const MAX_UPLOAD_BYTES = AUDIO_ZIP_LIMIT;
const bookTemp = require('node:fs/promises');
const PROXY_BASE = () => process.env.KADE_TTS_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app';
const DEFAULT_VOICE = () => process.env.KADE_READING_DEFAULT_VOICE || process.env.KADE_DEFAULT_VOICE || 'Kiana (Comedian)';
/** A bracket direction the proxy lifts into Inworld's instruction field —
 * not billed as text, and the whole of the room's "steering". `KADE_READING_STEER=`
 * (empty) turns it off; a reader can pass ?steer=0 on a chunk.
 *
 * Sep 12 2026, her word: "it sounds like it's reading the book really
 * monotone ... it needs to be like the characters ... with performance
 * instructions". The old direction ASKED for monotone ("steady audiobook
 * pace"). This one asks for a narrator's performance: voices in the dialogue,
 * the feeling of the scene, a storyteller's pace. Written the way Inworld's
 * best practices want a direction (lowercase, "and" joins, no punctuation)
 * so the proxy's sanitizer has nothing to strip. Pace words are deliberate:
 * "unhurried" alone measured +42% on the clock (proxy Part 109), so the
 * tempo here is "natural storytelling pace", not slow. */
const STEER = () => (process.env.KADE_READING_STEER != null ? process.env.KADE_READING_STEER : '[performing a novel aloud like a skilled audiobook narrator and giving each character a distinct voice in the dialogue and letting the feeling of each scene come through and keeping a natural storytelling pace]');

const upload = multer({ storage: multer.diskStorage({ destination: (req, _file, done) => done(null, req.bookUploadDirectory) }), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 8, fieldSize: 4096 } });
const mediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: TEXT_IMPORT_LIMIT, files: 1 } });

const isId = (s) => mongoose.Types.ObjectId.isValid(String(s || ''));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

async function isChild(req) {
  try {
    if (req.user && req.user.kadeAccountType) return req.user.kadeAccountType === 'child';
    const { getUserById } = require('~/models');
    const u = await getUserById(req.user.id, 'kadeAccountType');
    return !!(u && u.kadeAccountType === 'child');
  } catch (_) {
    return true; // when in doubt, the quieter shelf
  }
}
const isAdmin = (req) => req.user && req.user.role === 'ADMIN';
/** Who puts an upload straight into the family library, no approval step: the
 * librarian, and a trusted uploader (Amber A, Kade's word, Sep 24 2026) while
 * she has family access. Everyone else's upload lands on their own shelf. */
const canPublish = (req) => {
  const { familyLibraryMember, trustedLibraryContributor } = require('@librechat/api');
  return isAdmin(req) || (trustedLibraryContributor(String(req.user?.id)) && familyLibraryMember(req.user));
};
/** A trusted uploader sharing her own items answers her own waiting requests
 * for them: mark those approved, so they leave Kade's queue and digest. */
async function settleTrustedSubmissions(req, bookIds) {
  if (isAdmin(req) || !bookIds.length) return;
  await KadeLibrarySubmission.updateMany(
    { user: req.user.id, book: { $in: bookIds }, type: { $ne: 'report' }, status: 'pending' },
    { $set: { status: 'approved', decidedAt: new Date(), decisionNote: require('@librechat/api').trustedApprovalNote } },
  );
  refreshLibrarianDigest({ create: false });
}
/* Family library access, owner only (Sep 24 2026). The Library page's
 * "Family feature pack" section (client/public/assets/library/access.js):
 * since Part 293 the same permission is the Family feature pack. */
router.use('/membership', express.json({ limit: '2kb' }), require('@librechat/api').libraryMembershipRouter({
  auth: requireJwtAuth,
  owner: (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'Only the library owner manages the Family feature pack.' })),
  accounts: async () => {
    const { User } = require('~/db/models');
    return User.find({}, '_id name username email role kadeLibraryAccess').limit(2000).lean();
  },
  account: async (id) => {
    const { User } = require('~/db/models');
    return User.findById(id, '_id name username email role kadeLibraryAccess').lean();
  },
  setAccess: async (id, access) => {
    const { User } = require('~/db/models');
    return User.findOneAndUpdate({ _id: id, role: { $ne: 'ADMIN' } }, { $set: { kadeLibraryAccess: access } }, { new: true, projection: '_id name username email role kadeLibraryAccess' }).lean();
  },
  approveUploads: async (contributor, apply, decidedBy) => {
    const receipt = await require('@librechat/api').approveTrustedUploads({ books: KadeBook, submissions: KadeLibrarySubmission }, { contributor, decidedBy, apply });
    if (apply) {
      logger.info(`[library/membership] receipt ${JSON.stringify({ ...receipt, approved: receipt.approved.map((item) => item.id) })}`);
      await refreshLibrarianDigest({ create: false });
      if (receipt.approved.length) {
        const n = receipt.approved.length;
        notifyUser(contributor, `Kade approved your ${n} earlier library upload${n === 1 ? '' : 's'}. ${n === 1 ? 'It is' : 'They are'} in the family library now, and anything you upload from now on goes straight in.`);
      }
    }
    return receipt;
  },
  log: (message) => logger.info(`[library/membership] ${message}`),
}));

/** Can this reader open this book? Owner, admin, or it is in the library and
 * not hidden from a child. Returns the book or null (404 either way).
 * Sep 25 2026, the one-file rule: a copy folded into its keeper (state 'merged')
 * forwards to the keeper for 30 days (at most 3 hops), and the keeper is judged
 * on its own; a shortcut comes back with its keeper's file overlaid (`fileId`). */
async function openBook(req, id) {
  let book = null;
  for (let hops = 0; ; hops++) {
    if (!isId(id)) return null;
    book = await KadeBook.findById(id).lean();
    if (!book) return null;
    if (book.state !== 'merged') break;
    if (!book.mergedInto || hops >= 3) return null;
    id = book.mergedInto;
  }
  const mine = String(book.owner) === String(req.user.id);
  if (book.state !== 'ready' && !mine) return null;
  if (!(mine || isAdmin(req))) {
    if (!book.shared || libraryHiddenFrom(req)) return null;
    if (book.grownUpsOnly && (await isChild(req))) return null;
  }
  return book.shortcutOf ? libraryFiles.withFile(book, await readerFor(req)) : book;
}

function summary(book, progress) {
  const total = (book.sections || []).length;
  const s = progress ? progress.s : 0;
  const tracks = book.kind !== 'text' ? (book.tracks || []).length : 0;
  const seconds = book.kind !== 'text' ? (book.tracks || []).reduce((n, t) => n + (t.seconds || 0), 0) : 0;
  return {
    id: String(book._id),
    kind: book.kind || 'text',
    category: libraryCategory(book),
    description: book.description || '',
    tracks,
    seconds,
    state: book.state,
    path: libraryPath(book),
    storedPath: book.path || '',
    meta: book.meta || {},
    tags: book.tags || [],
    described: book.kind !== 'text' && (book.tracks || []).some((t) => t.description && t.description.state === 'done'),
    title: book.title,
    author: book.author,
    publisher: book.publisher,
    copyrightYear: book.copyrightYear,
    synopsis: book.synopsis,
    source: book.source,
    format: book.format,
    ownerName: book.ownerName,
    owner: String(book.owner),
    shared: !!book.shared,
    grownUpsOnly: !!book.grownUpsOnly,
    /** A shortcut to another item's file (the one-file rule), or null. */
    shortcutOf: book.shortcutOf ? String(book.shortcutOf) : null,
    sections: total,
    chunks: book.stats ? book.stats.chunks : 0,
    listen: book.stats ? book.stats.listen : '',
    skippedCount: (book.skipped || []).length,
    createdAt: book.createdAt,
    progress: progress
      ? { s: progress.s, c: progress.c, pos: progress.pos || 0, voice: progress.voice, speed: progress.speed, finished: !!progress.finished, updatedAt: progress.updatedAt,
          where: book.kind !== 'text' ? (tracks ? `${Math.min(s + 1, tracks)} of ${tracks}` : '') : total ? `${Math.min(s + 1, total)} of ${total}` : '' }
      : null,
  };
}

/* ── the shelf ─────────────────────────────────────────────────────────── */
router.get('/shelf', requireJwtAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const child = await isChild(req);
    const hidden = libraryHiddenFrom(req);
    const [mine, progress, library] = await Promise.all([
      // your own shelf items, plus any archive push that never finished (pending), so a stuck upload can be seen and deleted
      KadeBook.find({ owner: userId, $or: [{ state: 'ready', path: '' }, { state: 'pending' }] }).sort({ updatedAt: -1 }).limit(500).lean(),
      KadeReadingProgress.find({ user: userId }).sort({ updatedAt: -1 }).lean(),
      hidden ? [] : KadeBook.find({ shared: true, state: 'ready', path: '', ...(child ? { grownUpsOnly: { $ne: true } } : {}) }).sort({ sharedAt: -1 }).limit(500).lean(),
    ]);
    const progByBook = {};
    for (const p of progress) progByBook[String(p.book)] = p;
    const mineIds = new Set(mine.map((b) => String(b._id)));
    // books I checked out of the library (a progress row on someone else's shared book)
    const borrowedIds = progress.map((p) => String(p.book)).filter((id) => !mineIds.has(id));
    const borrowed = borrowedIds.length && !hidden
      ? await KadeBook.find({ _id: { $in: borrowedIds }, shared: true, state: 'ready', ...(child ? { grownUpsOnly: { $ne: true } } : {}) }).lean()
      : [];
    const borrowedOrder = {};
    borrowedIds.forEach((id, i) => { borrowedOrder[id] = i; });
    borrowed.sort((a, b) => borrowedOrder[String(a._id)] - borrowedOrder[String(b._id)]);
    const borrowedSet = new Set(borrowed.map((b) => String(b._id)));
    /* Her word (Sep 12): "why does it say the library is empty? All the material I'm
     * adding is for public consumption." The flat list used to hide her OWN shared items
     * (they were "on her shelf") and everything filed on a shelf (path != ''). Now the
     * list keeps her own loose items, and libraryCount says how much is really shared,
     * filed shelves included, so no screen calls a full library empty. */
    const sharedFilter = { shared: true, state: 'ready', ...(child ? { grownUpsOnly: { $ne: true } } : {}) };
    const [libraryCount, libraryFiled] = hidden ? [0, 0] : await Promise.all([
      KadeBook.countDocuments(sharedFilter),
      KadeBook.countDocuments({ ...sharedFilter, path: { $ne: '' } }),
    ]);
    res.json({
      librarian: isAdmin(req),
      // null for the App Review seat: its empty shelf stays silent, with no "ask Kade" notice.
      familyLibrary: hidden && require('@librechat/api').libraryReviewSeat(req.user) ? null : !hidden,
      describedVideo: !child && (isAdmin(req) || process.env.KADE_DESCRIPTION_PUBLIC !== '0'),
      me: String(userId),
      archiveOwned: await KadeBook.countDocuments({ owner: userId, path: { $ne: '' }, state: { $ne: 'merged' } }),
      libraryCount,
      libraryFiled,
      mine: mine.map((b) => summary(b, progByBook[String(b._id)])),
      borrowed: borrowed.map((b) => summary(b, progByBook[String(b._id)])),
      library: library.filter((b) => !borrowedSet.has(String(b._id))).map((b) => summary(b, progByBook[String(b._id)] || null)),
      categories: CATEGORIES,
      defaultVoice: DEFAULT_VOICE(),
      // The one-file rule's mode: the web page hashes a file before sending it only when 'on' (the
      // only mode that uses a client's hash); otherwise the server compares the stored bytes after.
      filesMode: filesMode(),
    });
  } catch (e) {
    logger.error('[reading-room/shelf] error:', e);
    res.status(500).json({ error: 'Could not load the shelf.' });
  }
});

/* ── upload ────────────────────────────────────────────────────────────── */
const activeBookUploads = new Set();
const ACCEPT_EXT = ['zip', 'epub', 'txt', 'docx', 'html', 'htm', 'xhtml', 'xml'];
router.post('/upload', requireJwtAuth, async (req, res, next) => {
  const uploader = String(req.user.id);
  if (activeBookUploads.has(uploader) || activeBookUploads.size >= 2) return res.status(429).json({ error: 'An audiobook import is already running. Let it finish, then try this ZIP again.' });
  activeBookUploads.add(uploader);
  res.once('close', () => { activeBookUploads.delete(uploader); if (req.bookUploadDirectory) bookTemp.rm(req.bookUploadDirectory, { recursive: true, force: true }).catch(() => {}); });
  try {
    req.bookUploadDirectory = await bookTemp.mkdtemp(require('node:path').join(require('node:os').tmpdir(), 'kade-book-'));
    if (res.destroyed) { await bookTemp.rm(req.bookUploadDirectory, { recursive: true, force: true }); return; }
  } catch (error) { return next(error); }

  upload.single('book')(req, res, (err) => {
    if (err) {
      logger.warn(`[reading-room/upload] REFUSED user=${req.user.id}: ${err.code || err.message}`);
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That ZIP exceeds the 4 GB audiobook import limit. Split it into smaller volumes, or add its recordings through Add audio or video.' : 'The file did not arrive. Try again.' });
    }
    next();
  });
}, importUploadedBook);

/* Sep 25 2026: Amber A restarted a Bookshare batch and 98 books were filed twice, because
 * nothing compared the text (each resent ZIP was a few bytes different). A text book whose
 * chunks match, one for one, a book this person can already open is not saved again; the
 * receipt names the copy already on the shelves. */
/** The words of a book, without the spoken jacket (it carries the title, which uploads may differ on).
 * One definition, shared with the same-text book merge (services/kadeLibraryFilesPlan.js). */
function bookTextDigest(sections, kinds) {
  return filesPlan.bookTextDigest(sections, kinds);
}

async function identicalBook(req, parsed) {
  const visible = [{ owner: req.user.id }];
  if (!libraryHiddenFrom(req)) visible.push({ shared: true, ...((await isChild(req)) ? { grownUpsOnly: { $ne: true } } : {}) });
  const candidates = await KadeBook.find({ kind: 'text', state: 'ready', 'stats.chars': parsed.stats.chars, 'stats.chunks': parsed.stats.chunks, $or: visible }).limit(10).lean();
  if (!candidates.length) return null;
  const digest = bookTextDigest(parsed.sections, parsed.sections.map((s) => s.kind));
  for (const candidate of candidates) {
    if ((candidate.sections || []).length !== parsed.sections.length) continue;
    const text = await KadeBookText.findOne({ book: candidate._id }).lean();
    if (text && bookTextDigest(text.sections, candidate.sections.map((s) => s.kind)) === digest) return candidate;
  }
  return null;
}

async function importUploadedBook(req, res) {
  const f = req.file;
  /* The librarian's and a trusted uploader's books go straight into the family library. */
  const publish = canPublish(req) && (req.body || {}).private !== '1';
  try {
    if (!f || !f.path || !f.size) return res.status(400).json({ error: 'No book arrived. Pick a file and try again.' });
    const ext = String(f.originalname || '').toLowerCase().split('.').pop();
    if (!ACCEPT_EXT.includes(ext)) {
      logger.warn(`[reading-room/upload] REFUSED user=${req.user.id} name=${String(f.originalname || '?').slice(0, 80)} mime=${f.mimetype || '(none)'}`);
      return res.status(400).json({ error: "I can't read that kind of file. Bookshare's DAISY zip, an EPUB, a text file, a Word file, or an HTML page all work." });
    }
    const t0 = Date.now();
    /* The one-file rule (Sep 25 2026): the server holds these bytes, so it hashes them here (the
     * import lane already hashed them on the way down). A copy the uploader can open that is exactly
     * this file answers "already in the library"; any other stored copy is only a silent link. */
    const mode = filesMode();
    let fileSha256 = '';
    let stored = null;
    try {
      fileSha256 = filesPlan.SHA256.test(String(req.fileSha256 || '')) ? String(req.fileSha256) : (await sha256OfFile(f.path)).sha256;
      stored = mode === 'off' ? null : await libraryFiles.storedTwin(await readerFor(req), fileSha256, f.size);
    } catch (e) {
      // The guard never stops an upload: without the check the book is stored as it always was.
      logger.warn(`[reading-room/upload] same-file check skipped (${e.message})`);
    }
    if (stored && stored.canOpen && mode === 'on') {
      logger.info(`[reading-room/upload] same file user=${req.user.id} name=${String(f.originalname || '?').slice(0, 80)} matches ${stored.twin._id}`);
      return res.json(alreadyAnswer(req, stored.twin, 'file'));
    }
    const sameOriginal = !!stored && stored.twin.fileSha256 === fileSha256 && Number(stored.twin.fileBytes) === Number(f.size);
    const storedOriginal = stored && !stored.canOpen && mode === 'on' && sameOriginal ? stored.twin : null;
    /* Report mode marks the new book as the extra copy only when 'on' mode would keep it once: the
     * whole original is the uploader's own stored copy, ready, not itself the marked one, and at
     * least as open as this upload (filesPlan.reportState). Anything else waits for the verifier. */
    const askedGrownUps = String((req.body || {}).grownUpsOnly || '') === '1' || (req.body || {}).grownUpsOnly === true;
    const flagged = stored && mode === 'report'
      && filesPlan.reportState({ item: { owner: req.user.id, shared: publish, grownUpsOnly: askedGrownUps, path: '' }, twin: stored.twin, canOpen: stored.canOpen, whole: sameOriginal }) === 'duplicate'
      ? { fileCheck: { state: 'duplicate', of: stored.twin._id, at: new Date() } } : null;
    if (ext === 'zip') {
      let archive;
      try { archive = await openAudioArchive(f.path); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      if (archive) {
        const daisy = archive.publication;
        const id = req.importBookId ? new mongoose.Types.ObjectId(req.importBookId) : new mongoose.Types.ObjectId();
        const uploaded = new Map();
        try {
          for (const clip of daisy.clips) {
            if (uploaded.has(clip.path)) continue;
            const media = mimeFor(clip.path);
            if (!media) throw new Error('This audio format is not supported.');
            if (media.ext === 'mp4') media.mime = 'audio/mp4';
            // Someone else's copy of this very ZIP already stores this clip: share it, upload nothing.
            const reuse = storedOriginal && (storedOriginal.tracks || []).find((t) => t && t.key && t.originalName === clip.path);
            if (reuse) { uploaded.set(clip.path, { key: reuse.key, bytes: reuse.bytes, mime: reuse.mime, sha256: reuse.sha256 || '', linked: true }); continue; }
            const key = req.importBookId ? `${MEDIA_PREFIX()}/${id}/import-${uploaded.size}.${media.ext}` : trackKey(id, media.ext);
            uploaded.set(clip.path, { key, bytes: archive.bytes(clip.path), mime: media.mime });
            const client = s3();
            if (!client || !MEDIA_BUCKET()) throw new Error('Audio storage is unavailable.');
            const storedClip = await storeAudioStream(client, MEDIA_BUCKET(), key, await archive.stream(clip.path), media.mime);
            if (storedClip && storedClip.sha256) uploaded.get(clip.path).sha256 = storedClip.sha256;
          }
          const clipTrack = (clip) => {
            const { linked: _linked, ...track } = uploaded.get(clip.path);
            return track;
          };
          const book = new KadeBook({ _id: id, owner: req.user.id,
            ownerName: String(req.user.name || req.user.username || '').split(' ')[0] || 'someone',
            kind: 'audio', category: 'audiobook', path: 'Audio/Audiobooks',
            title: daisy.title || f.originalname.replace(/\.zip$/i, ''), author: daisy.author,
            format: daisy.format, originalName: f.originalname, fileBytes: f.size, fileSha256,
            shared: publish, ...(publish ? { sharedAt: new Date() } : {}),
            grownUpsOnly: (req.body || {}).grownUpsOnly === '1', state: 'ready',
            ...(flagged || pendingCheck()),
            tracks: daisy.clips.map((clip) => ({ ...clipTrack(clip), title: clip.title,
              originalName: clip.path, clipBegin: clip.clipBegin, clipEnd: clip.clipEnd,
              seconds: clip.clipEnd === undefined ? 0 : clip.clipEnd - clip.clipBegin })),
          });
          refreshListen(book);
          await book.save();
          logger.info(`[reading-room/upload] audio ZIP ${id}: ${book.tracks.length} sections, ${uploaded.size} files${storedOriginal ? ' (stored bytes shared)' : ''}`);
          return res.json({ ok: true, book: summary(book.toObject(), null), skipped: [], jacket: '' });
        } catch (e) {
          // Never a shared clip: another row still plays it.
          await deleteKeys([...uploaded.values()].filter((x) => !x.linked).map((x) => x.key)).catch(() => {});
          logger.warn(`[reading-room/upload] audio ZIP failed: ${e.message}`);
          return res.status(400).json({ error: `The audio ZIP did not save. ${e.message}` });
        } finally { archive.close(); }
      }
    }
    if (f.size > TEXT_IMPORT_LIMIT) return res.status(400).json({ error: 'Text-book imports are limited to 256 MB. This ZIP did not contain supported audio recordings.' });
    f.buffer = await bookTemp.readFile(f.path);
    let parsed;
    try {
      parsed = await parseBook(f.buffer, f.originalname || 'book');
    } catch (e) {
      logger.warn(`[reading-room/upload] PARSE FAILED user=${req.user.id} name=${String(f.originalname || '?').slice(0, 80)} bytes=${f.buffer.length}: ${e.message}`);
      return res.status(400).json({ error: `I could not read that book. ${e.message}` });
    }
    if (!parsed.sections.length || parsed.stats.chars < 200) {
      return res.status(400).json({ error: 'No readable text or supported DAISY audio was found in this file.' });
    }
    const twin = await identicalBook(req, parsed);
    if (twin) {
      logger.info(`[reading-room/upload] duplicate user=${req.user.id} name=${String(f.originalname || '?').slice(0, 80)} matches ${twin._id} "${twin.title}"`);
      return res.json(alreadyAnswer(req, twin, 'text'));
    }
    const grownUpsOnly = String((req.body || {}).grownUpsOnly || '') === '1' || (req.body || {}).grownUpsOnly === true;
    let fileUrl = '';
    let fileKey = '';
    if (storedOriginal && (storedOriginal.fileKey || storedOriginal.fileUrl)) {
      // Someone else's stored original is exactly this file: this book reads its own parsed text and shares the bytes.
      fileUrl = storedOriginal.fileUrl || '';
      fileKey = await ensureFileKey(storedOriginal);
    } else {
      try {
        if (typeof saveBufferToS3 === 'function') {
          const fileName = req.importBookId ? `book-${req.importBookId}.${ext || 'bin'}` : `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext || 'bin'}`;
          fileUrl = (await saveBufferToS3({ userId: String(req.user.id), buffer: f.buffer, fileName, basePath: 'books' })) || '';
          fileKey = keyFromFileUrl(fileUrl);
        }
      } catch (e) {
        logger.warn(`[reading-room/upload] original not stored (${e.message}); the parsed text is enough to read`);
      }
    }
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const book = new KadeBook({
      ...(req.importBookId ? { _id: new mongoose.Types.ObjectId(req.importBookId) } : {}),
      owner: req.user.id,
      ownerName,
      shared: publish,
      ...(publish ? { sharedAt: new Date() } : {}),
      title: parsed.meta.title || String(f.originalname || 'Untitled').replace(/\.[^.]+$/, ''),
      author: parsed.meta.author || '',
      publisher: parsed.meta.sourcePublisher || (parsed.meta.publisher && !/bookshare/i.test(parsed.meta.publisher) ? parsed.meta.publisher : ''),
      copyrightYear: parsed.meta.copyrightYear || '',
      synopsis: parsed.meta.synopsis || '',
      language: parsed.meta.language || 'en',
      isbn: parsed.meta.isbn || '',
      bookshareId: parsed.meta.bookshareId || '',
      source: parsed.meta.source || 'upload',
      format: parsed.meta.format || ext,
      originalName: String(f.originalname || '').slice(0, 200),
      fileUrl,
      fileKey,
      fileBytes: f.buffer.length,
      fileSha256,
      ...(flagged || {}),
      jacket: parsed.jacket,
      sections: parsed.sections.map((s) => ({ title: s.title, chunkCount: s.chunks.length, chars: s.chars, kind: s.kind })),
      skipped: parsed.skipped.map((s) => ({ title: s.title, reason: s.reason, chunkCount: s.chunks.length, chars: s.chars })),
      stats: { chunks: parsed.stats.chunks, chars: parsed.stats.chars, listen: parsed.stats.listen },
      grownUpsOnly,
      parserVersion: PARSER_VERSION,
      state: 'ready',
    });
    await KadeBookText.updateOne({ book: book._id }, { $set: {
      sections: parsed.sections.map((s) => ({ chunks: s.chunks })),
      skipped: parsed.skipped.map((s) => ({ chunks: s.chunks })),
    } }, { upsert: true });
    await book.save();
    logger.info(`[reading-room/upload] user=${req.user.id} "${book.title}" ${parsed.meta.format} ${f.buffer.length}B -> ${parsed.stats.sections} sections, ${parsed.stats.chunks} chunks, ${parsed.stats.chars} chars, skipped ${parsed.stats.skipped.join(',') || 'nothing'} in ${Date.now() - t0}ms`);
    res.json({ ok: true, book: summary(book.toObject(), null), skipped: book.skipped, jacket: book.jacket });
  } catch (e) {
    logger.error('[reading-room/upload] error:', e);
    res.status(500).json({ error: 'The book did not save. Try again in a moment.' });
  } finally { if (req.bookUploadDirectory) await bookTemp.rm(req.bookUploadDirectory, { recursive: true, force: true }).catch(() => {}); }
}

router.use('/imports', express.json({ limit: '8kb' }), bookImportRouter({
  auth: requireJwtAuth,
  // kadeLibraryAccess rides the job so the finished import is shared (or not) by the uploader's own access
  actor: req => ({ id: String(req.user.id), name: req.user.name, username: req.user.username, email: req.user.email, role: req.user.role, kadeLibraryAccess: req.user.kadeLibraryAccess }),
  sign: (key, bytes) => signPut(key, 'application/octet-stream', bytes),
  head: headObject,
  download: async key => {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const result = await s3().send(new GetObjectCommand({ Bucket: MEDIA_BUCKET(), Key: key }));
    return result.Body;
  },
  remove: key => deleteKeys([key]),
  existing: async (id, owner) => {
    const book = await KadeBook.findOne({ _id: id, owner, state: { $in: ['ready', 'merged'] } }).lean();
    // A book folded into its keeper (the one-file rule) answers with the keeper for its 30 days.
    const shown = book && book.state === 'merged' ? await KadeBook.findOne({ _id: book.mergedInto, state: 'ready' }).lean() : book;
    return shown ? { ok: true, ...(shown !== book ? { duplicate: true, same: 'file' } : {}), book: summary(shown, null), skipped: shown.skipped || [], jacket: shown.jacket || '' } : null;
  },
  /* The one-file rule: a client-sent SHA-256 is only checked against copies this person can open,
   * and only answers; it never links or changes a row. */
  precheck: async (actor, sha256, bytes) => {
    if (filesMode() !== 'on') return null;
    const found = await libraryFiles.storedTwin(await requestReader(actor.id), sha256, bytes);
    if (!found || !found.canOpen) return null;
    logger.info(`[reading-room/import] user=${actor.id} precheck: same file as ${found.twin._id}`);
    return alreadyAnswer({ user: { id: actor.id } }, found.twin, 'file');
  },
  importFile: async (job, path, directory) => {
    let result;
    const response = { status() { return this; }, json(value) { result = value; return this; } };
    await importUploadedBook({ user: job.actor, importBookId: job._id, bookUploadDirectory: directory, fileSha256: job.sha256 || '',
      file: { path, size: job.bytes, originalname: job.fileName },
      body: { private: job.private ? '1' : '0', grownUpsOnly: job.grownUpsOnly ? '1' : '0' } }, response);
    return result || { error: 'The import did not return a result.' };
  },
  log: message => logger.warn('[reading-room/import] ' + message),
}));

/* ── one book ──────────────────────────────────────────────────────────── */
router.get('/book/:id', requireJwtAuth, async (req, res) => {
  try {
    let book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
    book = await reparseIfStale(book);
    let [progress, bookmarks] = await Promise.all([
      KadeReadingProgress.findOne({ user: req.user.id, book: book._id }).lean(),
      KadeReadingBookmark.find({ user: req.user.id, book: book._id }).sort({ createdAt: -1 }).lean(),
    ]);
    /* Her word: "anything they open and view … gets automatically categorised
     * in their personal shelf, where they can remove it later and it won't
     * remove from public access". Opening someone else's shared item makes
     * the progress row that IS the shelf entry. */
    if (!progress && String(book.owner) !== String(req.user.id)) {
      progress = await KadeReadingProgress.findOneAndUpdate({ user: req.user.id, book: book._id }, { $setOnInsert: { s: 0, c: 0, pos: 0 } }, { upsert: true, new: true }).lean();
    }
    let tracks = [];
    if (isMedia(book)) {
      tracks = await Promise.all((book.tracks || []).map(async (t, i) => {
        let url = '';
        try { url = await signGet(t.key, t.mime); } catch (e) { logger.warn(`[reading-room/book] sign failed for ${t.key}: ${e.message}`); }
        const d = t.description || {};
        return { s: i, title: t.title || `Part ${i + 1}`, seconds: t.seconds || 0, clipBegin: t.clipBegin || 0, clipEnd: t.clipEnd, bytes: t.bytes || 0, mime: t.mime, url,
          recaps: (t.recaps || []).map((r) => ({ from: r.from, to: r.to, summary: r.summary, scenes: r.scenes || [], at: r.at })),
          description: d.state ? { state: d.state, summary: d.summary || '', scenes: d.scenes || [], model: d.model || '', costUSD: d.costUSD || 0, error: d.error || '', at: d.at } : null };
      }));
    }
    res.json({
      ...summary(book, progress),
      tracks,
      librarian: book.librarian && book.librarian.state ? book.librarian : null,
      jacket: require('@librechat/api').readingJacket(book.jacket || ''),
      language: book.language || 'en',
      chapters: (book.sections || []).map((s, i) => ({ s: i, title: s.title, chunks: s.chunkCount, chars: s.chars, kind: s.kind })),
      skipped: (book.skipped || []).map((s, i) => ({ k: i, title: s.title, reason: s.reason, chunks: s.chunkCount, chars: s.chars })).filter((s) => !noticeHidden(req, book, s.k)),
      bookmarks: bookmarks.map((b) => ({ id: String(b._id), s: b.s, c: b.c, pos: b.pos || 0, note: b.note, snippet: b.snippet, sectionTitle: b.sectionTitle, createdAt: b.createdAt })),
      mine: String(book.owner) === String(req.user.id),
      defaultVoice: DEFAULT_VOICE(),
    });
  } catch (e) {
    logger.error('[reading-room/book] error:', e);
    res.status(500).json({ error: 'Could not open that book.' });
  }
});

async function chunkAt(book, s, c, skipped) {
  // A shortcut reads its keeper's words (`fileId`, the one-file rule).
  const text = await KadeBookText.findOne({ book: book.fileId || book._id }, skipped ? { skipped: { $slice: [s, 1] } } : { sections: { $slice: [s, 1] } }).lean();
  const list = skipped ? (text && text.skipped) || [] : (text && text.sections) || [];
  const sec = list[0];
  if (!sec || !sec.chunks || c >= sec.chunks.length) return null;
  const meta = skipped ? (book.skipped || [])[s] : (book.sections || [])[s];
  const counts = skipped ? (book.skipped || []).map((x) => x.chunkCount) : (book.sections || []).map((x) => x.chunkCount);
  const next = c + 1 < sec.chunks.length ? { s, c: c + 1 } : s + 1 < counts.length ? { s: s + 1, c: 0 } : null;
  const prev = c > 0 ? { s, c: c - 1 } : s > 0 ? { s: s - 1, c: Math.max(0, (counts[s - 1] || 1) - 1) } : null;
  // Jackets cut before Sep 24 2026 still end with the old Bookshare line; heard and seen as the neutral one.
  const words = meta?.kind === 'jacket' ? require('@librechat/api').readingJacket(sec.chunks[c]) : sec.chunks[c];
  return { text: words, title: meta ? meta.title : '', s, c, count: sec.chunks.length, next, prev };
}
/* Sep 24 2026: an accessible edition's notice can name the person who
 * downloaded the file. Only the uploader and the librarian see or hear it in
 * Skipped parts; everyone else has the jacket's one neutral sentence. */
function noticeHidden(req, book, k) {
  if (String(book.owner) === String(req.user.id) || isAdmin(req)) return false;
  return NOTICE_REASONS.has(((book.skipped || [])[k] || {}).reason);
}

router.get('/book/:id/text/:s/:c', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
    const skipped = req.query.skipped === '1';
    const s = clampInt(req.params.s, 0, 100000, 0);
    const c = clampInt(req.params.c, 0, 100000, 0);
    if (skipped && noticeHidden(req, book, s)) return res.status(404).json({ error: 'Past the end of the book.' });
    const chunk = await chunkAt(book, s, c, skipped);
    if (!chunk) return res.status(404).json({ error: 'Past the end of the book.' });
    // what the screen shows: the passage without the voices' steering (narration keeps it)
    res.json({ ...chunk, text: require('@librechat/api').readingText(chunk.text) });
  } catch (e) {
    logger.error('[reading-room/text] error:', e);
    res.status(500).json({ error: 'Could not read that part.' });
  }
});

/* ── the reading view (Sep 24 2026) ────────────────────────────────────────
 * Her ask: a view for low-vision and sighted readers following a book while
 * it is narrated. One page of a section per request (the route above is one
 * passage), cleaned the same way; positions match the narration's, so an
 * emptied passage keeps its slot. */
router.get('/book/:id/passages/:s', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book || isMedia(book)) return res.status(404).json({ error: 'No such book on your shelf.' });
    const s = clampInt(req.params.s, 0, 100000, 0);
    const from = clampInt(req.query.from, 0, 100000, 0);
    const count = clampInt(req.query.count, 1, 60, 40);
    const meta = (book.sections || [])[s];
    const text = meta ? await KadeBookText.findOne({ book: book.fileId || book._id }, { sections: { $slice: [s, 1] } }).lean() : null;
    const chunks = (text && text.sections && text.sections[0] && text.sections[0].chunks) || [];
    if (!meta || from >= chunks.length) return res.status(404).json({ error: 'Past the end of the book.' });
    res.json({ s, title: meta.title || '', from, total: chunks.length, passages: require('@librechat/api').readingPassages(chunks, meta.kind, from, count) });
  } catch (e) {
    logger.error('[reading-room/passages] error:', e);
    res.status(500).json({ error: 'Could not load that page of the book.' });
  }
});

/* ── the voice ─────────────────────────────────────────────────────────── */
router.get('/book/:id/audio/:s/:c', requireJwtAuth, async (req, res) => {
  const t0 = Date.now();
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
    const skipped = req.query.skipped === '1';
    const s = clampInt(req.params.s, 0, 100000, 0);
    const c = clampInt(req.params.c, 0, 100000, 0);
    if (skipped && noticeHidden(req, book, s)) return res.status(404).json({ error: 'Past the end of the book.' });
    const chunk = await chunkAt(book, s, c, skipped);
    if (!chunk) return res.status(404).json({ error: 'Past the end of the book.' });
    // an old jacket's lone "Please do not pass this book on." cleans to nothing: skip it
    if (!String(chunk.text || '').trim()) return res.status(204).end();
    const voice = String(req.query.voice || DEFAULT_VOICE()).slice(0, 120);
    const speed = Math.max(0.5, Math.min(1.5, parseFloat(req.query.speed) || 1));
    const delivery = ['STABLE', 'BALANCED', 'CREATIVE'].includes(req.query.delivery) ? req.query.delivery : 'STABLE';
    const steer = req.query.steer === '0' ? '' : STEER();
    const input = (steer ? steer + ' ' : '') + chunk.text;
    const headers = {
      'Content-Type': 'application/json',
      'x-kade-tts-session': `reading:${String(req.user.id).slice(0, 24)}:${String(book._id).slice(-12)}`,
      'x-kade-tts-stream': '1',
    };
    const upstream = await axios.post(
      `${PROXY_BASE()}/v1/audio/speech`,
      { input, voice, model: 'tts-1', speed, delivery, stream: '1' },
      { headers, responseType: 'stream', timeout: 60000, validateStatus: () => true },
    );
    if (upstream.status !== 200) {
      let body = '';
      try { for await (const b of upstream.data) { body += b.toString(); if (body.length > 500) break; } } catch (_) {}
      logger.warn(`[reading-room/audio] proxy ${upstream.status} user=${req.user.id} book=${book._id} ${s}/${c}: ${body.slice(0, 200)}`);
      return res.status(502).json({ error: 'The voice did not answer. Try that part again.' });
    }
    if (String(upstream.headers['content-length']) === '0') {
      res.status(204).end();
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Kade-Reading-Position', `${s}/${c}`);
    if (upstream.headers['x-kade-tts-streamed']) res.setHeader('x-kade-tts-streamed', '1');
    let bytes = 0;
    upstream.data.on('data', (b) => { bytes += b.length; });
    upstream.data.on('end', () => {
      logger.info(`[reading-room/audio] user=${req.user.id} book=${book._id} ${skipped ? 'skipped ' : ''}${s}/${c} ${chunk.text.length}ch voice="${voice}" x${speed} ${bytes}B ${Date.now() - t0}ms`);
      logKadeUsage({ userId: req.user.id, service: 'tts', quantity: chunk.text.length, unit: 'chars', metadata: { path: 'reading-room', book: String(book._id), s, c, voice } });
    });
    upstream.data.on('error', (e) => { logger.warn(`[reading-room/audio] upstream stream error: ${e.message}`); try { res.end(); } catch (_) {} });
    req.on('close', () => { try { upstream.data.destroy(); } catch (_) {} });
    upstream.data.pipe(res);
  } catch (e) {
    logger.error('[reading-room/audio] error:', e && e.message ? e.message : e);
    if (!res.headersSent) res.status(502).json({ error: 'The voice did not answer. Try that part again.' });
  }
});

/* ── progress and bookmarks ────────────────────────────────────────────── */
router.post('/book/:id/progress', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
    const b = req.body || {};
    const audio = isMedia(book);
    const sections = audio ? (book.tracks || []).length : (book.sections || []).length;
    const s = clampInt(b.s, 0, Math.max(0, sections - 1), 0);
    const c = audio ? 0 : clampInt(b.c, 0, Math.max(0, ((book.sections || [])[s] || { chunkCount: 1 }).chunkCount - 1), 0);
    const position = Number(b.pos);
    const set = { s, c, pos: Number.isFinite(position) ? Math.max(0, position) : 0 };
    if (typeof b.voice === 'string') set.voice = b.voice.slice(0, 120);
    if (b.speed != null) set.speed = Math.max(0.5, Math.min(1.5, parseFloat(b.speed) || 1));
    if (typeof b.finished === 'boolean') set.finished = b.finished;
    const row = await KadeReadingProgress.findOneAndUpdate({ user: req.user.id, book: book._id }, { $set: set }, { upsert: true, new: true }).lean();
    res.json({ ok: true, progress: { s: row.s, c: row.c, pos: row.pos || 0, voice: row.voice, speed: row.speed, finished: !!row.finished } });
  } catch (e) {
    logger.error('[reading-room/progress] error:', e);
    res.status(500).json({ error: 'Could not save your place.' });
  }
});

router.get('/book/:id/bookmarks', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
    const rows = await KadeReadingBookmark.find({ user: req.user.id, book: book._id }).sort({ createdAt: -1 }).lean();
    res.json({ bookmarks: rows.map((b) => ({ id: String(b._id), s: b.s, c: b.c, note: b.note, snippet: b.snippet, sectionTitle: b.sectionTitle, createdAt: b.createdAt })) });
  } catch (e) {
    res.status(500).json({ error: 'Could not load bookmarks.' });
  }
});

router.post('/book/:id/bookmarks', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
    const b = req.body || {};
    const s = clampInt(b.s, 0, 100000, 0);
    const c = clampInt(b.c, 0, 100000, 0);
    const pos = Math.max(0, parseFloat(b.pos) || 0);
    let chunk;
    if (isMedia(book)) {
      const t = (book.tracks || [])[s];
      if (!t) return res.status(400).json({ error: 'That spot is past the end.' });
      const m = Math.floor(pos / 60); const sec = Math.floor(pos % 60);
      chunk = { text: `${t.title || `Part ${s + 1}`} at ${m}:${String(sec).padStart(2, '0')}`, title: t.title || `Part ${s + 1}` };
    } else {
      chunk = await chunkAt(book, s, c, false);
      if (!chunk) return res.status(400).json({ error: 'That spot is past the end of the book.' });
    }
    const count = await KadeReadingBookmark.countDocuments({ user: req.user.id, book: book._id });
    if (count >= 200) return res.status(400).json({ error: 'Two hundred bookmarks in one book is the limit — remove a few first.' });
    const row = await KadeReadingBookmark.create({
      user: req.user.id, book: book._id, s, c, pos,
      note: String(b.note || '').slice(0, 400),
      snippet: require('@librechat/api').readingText(chunk.text).slice(0, 120),
      sectionTitle: chunk.title,
    });
    res.json({ ok: true, bookmark: { id: String(row._id), s, c, pos, note: row.note, snippet: row.snippet, sectionTitle: row.sectionTitle, createdAt: row.createdAt } });
  } catch (e) {
    logger.error('[reading-room/bookmark] error:', e);
    res.status(500).json({ error: 'Could not place that bookmark.' });
  }
});

router.delete('/book/:id/bookmarks/:bid', requireJwtAuth, async (req, res) => {
  try {
    if (!isId(req.params.id) || !isId(req.params.bid)) return res.status(404).json({ error: 'No such bookmark.' });
    const r = await KadeReadingBookmark.deleteOne({ _id: req.params.bid, user: req.user.id, book: req.params.id });
    res.json({ ok: true, removed: r.deletedCount || 0 });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove that bookmark.' });
  }
});


/* ── audio donations (Part 181 continued) ──────────────────────────────── */
router.post('/media/new', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'Give it a title first.' });
    const category = CATEGORIES.includes(String(b.category)) && b.category !== 'book' ? String(b.category) : 'other';
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const item = await KadeBook.create({
      kind: 'audio',
      category,
      shared: canPublish(req) && b.private !== true,
      owner: req.user.id,
      ownerName,
      title,
      author: String(b.author || '').trim().slice(0, 200),
      copyrightYear: String(b.year || '').trim().slice(0, 12),
      description: String(b.description || '').trim().slice(0, 2000),
      synopsis: String(b.description || '').trim().slice(0, 2000),
      source: 'upload',
      format: 'audio',
      grownUpsOnly: b.grownUpsOnly === true || String(b.grownUpsOnly) === '1',
      state: 'pending',
      jacket: '',
    });
    logger.info(`[reading-room/media] user=${req.user.id} new ${category} "${title}" (${item._id})`);
    res.json({ ok: true, item: summary(item.toObject(), null) });
  } catch (e) {
    logger.error('[reading-room/media/new] error:', e);
    res.status(500).json({ error: 'Could not start that donation.' });
  }
});

async function ownAudio(req, id) {
  if (!isId(id)) return null;
  const item = await KadeBook.findById(id);
  if (!item || item.kind === 'text') return null;
  if (String(item.owner) !== String(req.user.id) && !isAdmin(req)) return null;
  return item;
}
const isMedia = (b) => b && (b.kind === 'audio' || b.kind === 'video');

/** A client-claimed SHA-256 (the one-file rule, KADE_LIBRARY_FILES=on): only a stored copy this
 * person can already open answers, and nothing is linked or changed on the client's word. */
async function claimedTwin(req, sha256, bytes) {
  if (filesMode() !== 'on' || !filesPlan.SHA256.test(String(sha256 || '')) || !(bytes > 0)) return null;
  const found = await libraryFiles.storedTwin(await readerFor(req), String(sha256), bytes);
  return found && found.canOpen ? found.twin : null;
}

/** Step 1 of a direct upload: a signed PUT the client sends the bytes to. */
router.post('/media/:id/track/presign', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const b = req.body || {};
    const m = mimeFor(b.fileName, b.mime);
    if (!m) return res.status(400).json({ error: 'That is not an audio or video file. MP3, M4A, M4B, AAC, WAV, OGG, FLAC, MP4, M4V, MOV or WebM all work.' });
    const bytes = Math.max(0, parseInt(b.bytes, 10) || 0);
    if (!bytes || bytes > MAX_TRACK_BYTES) return res.status(400).json({ error: 'One file is over 20 GB — split it into parts.' });
    if ((item.tracks || []).length >= 200) return res.status(400).json({ error: 'Two hundred parts is the limit for one item.' });
    if (item.shortcutOf) return res.status(400).json({ error: 'This is a shortcut to another item. Add parts on the original.' });
    /* The one-file rule: a part that is exactly a stored file is always accepted (the verifier points
     * it at the stored bytes after, so a cassette whose side A is on another tape can still get its
     * side B). Only a brand-new, empty donation whose one file would be a whole copy of a one-file
     * item they can open is skipped: nothing is sent, the empty item goes, and she is told so. */
    const empty = !(item.tracks || []).length && item.state === 'pending' && String(item.owner) === String(req.user.id);
    const twin = b.sha256 && empty ? await claimedTwin(req, b.sha256, bytes) : null;
    if (twin && twin.kind !== 'text' && (twin.tracks || []).length === 1) {
      await KadeBook.deleteOne({ _id: item._id, state: 'pending', tracks: { $size: 0 } });
      logger.info(`[reading-room/media] user=${req.user.id} empty donation ${item._id} removed: its one file is ${twin._id}`);
      return res.json({
        ...alreadyAnswer(req, twin, 'file'), existing: summary(twin, null), removed: String(item._id),
        message: filesPlan.nothingUploadedLine(twin, twin.shared ? libraryPath(twin) : '', { own: String(twin.owner) === String(req.user.id) && !twin.shared, started: item.title }),
      });
    }
    const key = trackKey(item._id, m.ext);
    if (b.multipart === true && bytes > MULTIPART_ABOVE) {
      const uploadId = await createMultipart(key, m.mime);
      const parts = [];
      for (let i = 1; i <= Math.ceil(bytes / MULTIPART_PART_BYTES); i++) parts.push({ partNumber: i, url: await signPart(key, uploadId, i) });
      return res.json({ ok: true, key, mime: m.mime, multipart: { uploadId, partBytes: MULTIPART_PART_BYTES, parts } });
    }
    const url = await signPut(key, m.mime, bytes);
    res.json({ ok: true, key, url, mime: m.mime, method: 'PUT', headers: { 'Content-Type': m.mime }, expiresInSeconds: 3 * 3600 });
  } catch (e) {
    logger.error('[reading-room/media/presign] error:', e.message);
    res.status(500).json({ error: 'Could not prepare the upload. ' + (/(not configured)/.test(e.message) ? 'Media storage is not set up.' : 'Try again.') });
  }
});

/** Step 2: the client says the bytes landed; we check the object exists. */
router.post('/media/:id/track/done', requireJwtAuth, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const b = req.body || {};
    const key = String(b.key || '');
    if (!key.startsWith(`${MEDIA_PREFIX()}/${item._id}/`)) return res.status(400).json({ error: 'That upload does not belong to this item.' });
    if ((item.tracks || []).some((t) => t.key === key)) return res.json({ ok: true, item: summary(item.toObject(), null) });
    if (b.multipart) {
      const parts = b.multipart.parts;
      if (typeof b.multipart.uploadId !== 'string' || !Array.isArray(parts) || !parts.length || parts.length > 410 ||
          parts.some((p, i) => p.partNumber !== i + 1 || typeof p.etag !== 'string' || !p.etag || p.etag.length > 200)) return res.status(400).json({ error: 'Invalid multipart receipt.' });
      let completed = false;
      try { completed = Number((await headObject(key)).ContentLength) === Number(b.bytes); } catch (_) {}
      if (!completed) await completeMultipart(key, b.multipart.uploadId, parts);
    }
    let head;
    try { head = await headObject(key); } catch (e) { return res.status(400).json({ error: 'The file did not arrive in storage. Try the upload again.' }); }
    if (Number(b.bytes) > 0 && Number(head.ContentLength) !== Number(b.bytes)) return res.status(400).json({ error: 'The stored file size does not match. Retry the upload.' });
    const ext = key.split('.').pop();
    item.tracks.push({
      title: String(b.title || '').trim().slice(0, 200) || `Part ${item.tracks.length + 1}`,
      key,
      bytes: Number(head.ContentLength) || Math.max(0, parseInt(b.bytes, 10) || 0),
      seconds: Math.max(0, parseFloat(b.seconds) || 0),
      mime: MEDIA_EXT[ext] || head.ContentType || 'audio/mpeg',
      originalName: String(b.originalName || '').slice(0, 200),
      etag: String(head.ETag || '').replace(/"/g, ''),
    });
    if (VIDEO_EXT[ext] && item.kind !== 'video') item.kind = 'video';
    item.state = 'ready';
    Object.assign(item, pendingCheck()); // the one-file rule's verifier compares it within 2 minutes
    refreshListen(item);
    await item.save();
    logger.info(`[reading-room/media] user=${req.user.id} "${item.title}" +track ${key} ${head.ContentLength || '?'}B (${item.tracks.length} total)`);
    res.json({ ok: true, item: summary(item.toObject(), null) });
  } catch (e) {
    logger.error('[reading-room/media/done] error:', e);
    res.status(500).json({ error: 'Could not record that upload.' });
  }
});

/** The through-the-server lane (<= 256 MB): for browsers until the bucket has
 * a CORS rule, and for anything small. Same result as presign + done. */
router.post('/media/:id/track/upload', requireJwtAuth, (req, res, next) => {
  mediaUpload.single('track')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Over 256 MB — the phone app sends big recordings straight to storage; on the web, split it into parts.' : 'The file did not arrive.' });
    next();
  });
}, async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const f = req.file;
    if (!f || !f.buffer || !f.buffer.length) return res.status(400).json({ error: 'No recording arrived.' });
    const m = mimeFor(f.originalname, f.mimetype);
    if (!m) return res.status(400).json({ error: 'That is not an audio or video file. MP3, M4A, M4B, AAC, WAV, OGG, FLAC, MP4, M4V, MOV or WebM all work.' });
    const mime = m.mime;
    if (item.shortcutOf) return res.status(400).json({ error: 'This is a shortcut to another item. Add parts on the original.' });
    const key = trackKey(item._id, m.ext);
    await putBuffer(key, f.buffer, mime);
    item.tracks.push({
      title: String((req.body || {}).title || '').trim().slice(0, 200) || `Part ${item.tracks.length + 1}`,
      key, bytes: f.buffer.length, seconds: Math.max(0, parseFloat((req.body || {}).seconds) || 0), mime,
      originalName: String(f.originalname || '').slice(0, 200),
      sha256: sha256OfBuffer(f.buffer), // the server holds these bytes: the one-file rule's hash costs no read
    });
    if (m.kind === 'video') item.kind = 'video';
    item.state = 'ready';
    Object.assign(item, pendingCheck());
    refreshListen(item);
    await item.save();
    logger.info(`[reading-room/media] user=${req.user.id} "${item.title}" +track(server) ${key} ${f.buffer.length}B`);
    res.json({ ok: true, item: summary(item.toObject(), null) });
  } catch (e) {
    logger.error('[reading-room/media/upload] error:', e.message);
    res.status(500).json({ error: 'The recording did not save. ' + (/(not configured)/.test(e.message) ? 'Media storage is not set up.' : 'Try again.') });
  }
});

router.post('/media/:id/track/:t/remove', requireJwtAuth, async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const t = clampInt(req.params.t, 0, 10000, -1);
    if (t < 0 || t >= item.tracks.length) return res.status(404).json({ error: 'No such part.' });
    if (item.shortcutOf) return res.status(400).json({ error: 'This is a shortcut to another item. Change its parts on the original.' });
    const [gone] = item.tracks.splice(t, 1);
    if (!item.tracks.length) { item.state = 'pending'; item.shared = false; }
    refreshListen(item);
    await item.save();
    /* Only when no other row (a link, a folded copy) still lists the file. A shortcut to this item
     * never keeps a removed part alive: it plays the item's current parts, never its own old copy. */
    const pointers = (await KadeBook.find({ shortcutOf: item._id }, '_id').lean()).map((r) => r._id);
    /* Their own track lists drop the part too, so no row goes on listing bytes that are about to go. */
    if (pointers.length && gone.key) await KadeBook.updateMany({ _id: { $in: pointers } }, { $pull: { tracks: { key: gone.key } } }).catch(() => {});
    libraryFiles.releaseKeys([gone.key], { except: pointers }).catch(() => {});
    res.json({ ok: true, item: summary(item.toObject(), null) });
  } catch (e) {
    res.status(500).json({ error: 'Could not remove that part.' });
  }
});

router.post('/media/:id/edit', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) item.title = b.title.trim().slice(0, 200);
    if (typeof b.author === 'string') item.author = b.author.trim().slice(0, 200);
    if (typeof b.year === 'string') item.copyrightYear = b.year.trim().slice(0, 12);
    if (typeof b.description === 'string') { item.description = b.description.trim().slice(0, 2000); item.synopsis = item.description; }
    if (CATEGORIES.includes(String(b.category)) && b.category !== 'book') item.category = String(b.category);
    if (Array.isArray(b.trackTitles)) b.trackTitles.forEach((t, i) => { if (item.tracks[i] && typeof t === 'string' && t.trim()) item.tracks[i].title = t.trim().slice(0, 200); });
    await item.save();
    res.json({ ok: true, item: summary(item.toObject(), null) });
  } catch (e) {
    res.status(500).json({ error: 'Could not save those changes.' });
  }
});


/* ── THE ARCHIVE: her sorter's collection, pushed folder by folder ──────────
 * (Part 181 continued). `push_to_library.py` on her PC walks
 * F:\youtube\Video\<Category>\... and sends each clip straight to B2 with
 * these batch routes: one call presigns up to 50 files (creating their
 * items as `pending`, path + catalogue row attached), one call marks them
 * landed. Files over 4 GB go up in parts through the S3 multipart lane.
 * Everything pushed is `shared` unless the tool says private — it is the
 * family's collection. */
const ARCHIVE_CATEGORY = (topFolder) => {
  const t = String(topFolder || '').toLowerCase();
  if (/commercial/.test(t)) return 'commercials';
  if (/psa/.test(t)) return 'psa';
  if (/home video|vhs|found cassette|tape/.test(t)) return 'vhs';
  if (/movie|studio/.test(t)) return 'movie';
  if (/music/.test(t)) return 'music';
  if (/radio|podcast/.test(t)) return 'radio';
  if (/channel|tv|show|missouri|ozark|station|sign-?off|network/.test(t)) return 'tv';
  return 'other';
};
const cleanPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, '.').slice(0, 400);

async function createMultipart(key, contentType) {
  const client = s3();
  const { CreateMultipartUploadCommand } = require('@aws-sdk/client-s3');
  const r = await client.send(new CreateMultipartUploadCommand({ Bucket: MEDIA_BUCKET(), Key: key, ContentType: contentType }));
  return r.UploadId;
}
async function signPart(key, uploadId, partNumber) {
  const client = s3();
  const { UploadPartCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(client, new UploadPartCommand({ Bucket: MEDIA_BUCKET(), Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: 6 * 3600 });
}
async function completeMultipart(key, uploadId, parts) {
  const client = s3();
  const { CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');
  await client.send(new CompleteMultipartUploadCommand({ Bucket: MEDIA_BUCKET(), Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })) } }));
}

router.post('/archive/presign', requireJwtAuth, express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const files = Array.isArray(b.files) ? b.files.slice(0, 50) : [];
    if (!files.length) return res.status(400).json({ error: 'No files listed.' });
    const shared = b.private === true ? false : canPublish(req);
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const out = [];
    for (const f of files) {
      const originalPath = cleanPath(f.originalPath || (f.path && f.name ? `${f.path}/${f.name}` : f.name));
      const m = mimeFor(f.name, f.mime);
      if (!m) { out.push({ originalPath, error: 'not a playable audio or video file' }); continue; }
      const bytes = Math.max(0, parseInt(f.bytes, 10) || 0);
      if (bytes > MAX_TRACK_BYTES) { out.push({ originalPath, error: 'over 20 GB' }); continue; }
      // a real document, not lean(): a pending row from an earlier try is reused and saved below
      const existing = await KadeBook.findOne({ owner: req.user.id, originalPath });
      if (existing && existing.state === 'ready') { out.push({ originalPath, id: String(existing._id), skipped: 'already in the library' }); continue; }
      /* The one-file rule: the push tool sends each file's SHA-256. Exactly this file is already a
       * copy this person can open, so it is not sent again (only such a copy is ever named). */
      const twin = f.sha256 && bytes ? await claimedTwin(req, f.sha256, bytes) : null;
      if (twin) {
        if (existing && existing.state === 'pending' && !(existing.tracks || []).length) await KadeBook.deleteOne({ _id: existing._id, state: 'pending' });
        out.push({ originalPath, id: String(twin._id), skipped: 'already in the library', same: 'file', title: twin.title, path: libraryPath(twin) });
        continue;
      }
      const folder = cleanPath(f.path || '');
      const top = folder.split('/')[1] || folder.split('/')[0] || '';
      const title = bareTitle(f.title || f.name || 'Untitled').slice(0, 200) || 'Untitled';
      const meta = f.meta && typeof f.meta === 'object' ? Object.fromEntries(Object.entries(f.meta).slice(0, 20).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 120)])) : {};
      const doc = existing || new KadeBook({ owner: req.user.id, ownerName });
      doc.kind = m.kind;
      doc.category = CATEGORIES.includes(String(f.category)) ? String(f.category) : ARCHIVE_CATEGORY(top);
      doc.title = title;
      doc.author = String(meta.network || meta.cableChannel || meta.callSign || meta.brand || '').slice(0, 200);
      doc.copyrightYear = String(meta.year || '').slice(0, 12);
      doc.description = String(f.description || '').slice(0, 2000);
      doc.path = folder;
      Object.assign(doc, refineMediaFiling(doc, true) || {});
      doc.originalPath = originalPath;
      doc.meta = meta;
      doc.tags = [top, meta.decade, meta.type, meta.market].filter(Boolean).map((x) => String(x).slice(0, 60));
      doc.source = 'archive';
      doc.format = m.kind;
      doc.shared = shared;
      if (shared && !doc.sharedAt) doc.sharedAt = new Date();
      doc.grownUpsOnly = f.grownUpsOnly === true;
      doc.state = 'pending';
      doc.tracks = [];
      await doc.save();
      const key = trackKey(doc._id, m.ext);
      if (bytes > MULTIPART_ABOVE) {
        const uploadId = await createMultipart(key, m.mime);
        const partCount = Math.ceil(bytes / MULTIPART_PART_BYTES);
        const parts = [];
        for (let i = 1; i <= partCount; i++) parts.push({ partNumber: i, url: await signPart(key, uploadId, i) });
        out.push({ originalPath, id: String(doc._id), key, mime: m.mime, multipart: { uploadId, partBytes: MULTIPART_PART_BYTES, parts } });
      } else {
        out.push({ originalPath, id: String(doc._id), key, mime: m.mime, url: await signPut(key, m.mime, bytes) });
      }
    }
    logger.info(`[library/archive] user=${req.user.id} presigned ${out.filter((o) => o.key).length}/${files.length} (${out.filter((o) => o.skipped).length} already there)`);
    res.json({ ok: true, files: out });
  } catch (e) {
    logger.error(`[library/archive/presign] error: ${e.message}`);
    res.status(500).json({ error: 'Could not prepare those uploads. ' + (/(not configured)/.test(e.message) ? 'Media storage is not set up.' : e.message) });
  }
});

router.post('/archive/done', requireJwtAuth, express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const files = Array.isArray((req.body || {}).files) ? req.body.files.slice(0, 50) : [];
    const out = [];
    for (const f of files) {
      if (!isId(f.id)) { out.push({ id: f.id, error: 'bad id' }); continue; }
      const item = await KadeBook.findOne({ _id: f.id, owner: req.user.id });
      if (!item || item.kind === 'text') { out.push({ id: f.id, error: 'no such item' }); continue; }
      const key = String(f.key || '');
      if (!key.startsWith(`${MEDIA_PREFIX()}/${item._id}/`)) { out.push({ id: f.id, error: 'key does not belong to this item' }); continue; }
      try {
        if (f.multipart && f.multipart.uploadId && Array.isArray(f.multipart.parts)) await completeMultipart(key, f.multipart.uploadId, f.multipart.parts);
        const head = await headObject(key);
        const ext = key.split('.').pop();
        item.tracks = [{ title: item.title, key, bytes: Number(head.ContentLength) || 0, seconds: Math.max(0, parseFloat(f.seconds) || 0), mime: MEDIA_EXT[ext] || head.ContentType || 'video/mp4', originalName: String(f.originalName || '').slice(0, 200), etag: String(head.ETag || '').replace(/"/g, '') }];
        if (VIDEO_EXT[ext]) item.kind = 'video';
        item.state = 'ready';
        Object.assign(item, pendingCheck()); // the one-file rule's verifier compares it (kicked below)
        Object.assign(item, refineMediaFiling(item, true) || {});
        refreshListen(item);
        await item.save();
        out.push({ id: String(item._id), ok: true, bytes: item.tracks[0].bytes });
      } catch (e) {
        logger.warn(`[library/archive/done] ${item._id} not in storage: ${e.name || ''} ${e.message} (${e.$metadata && e.$metadata.httpStatusCode})`);
        out.push({ id: String(item._id), error: 'the file is not in storage: ' + (e.name === 'UnknownError' || e.name === 'NotFound' ? 'it never arrived (a refused upload - check the Backblaze storage cap)' : e.message) });
      }
    }
    res.json({ ok: true, files: out });
    if (out.some((o) => o.ok)) void libraryFiles.verifyPass({ limit: 50 }).catch(() => {});
  } catch (e) {
    logger.error(`[library/archive/done] error: ${e.message}`);
    res.status(500).json({ error: 'Could not record those uploads.' });
  }
});

/** Browse the archive like a drive: folders under `path`, items at `path`. */
router.use('/archive/descriptions', descriptionBatchRouter({
  auth: requireJwtAuth,
  owner: (req) => String(req.user.id),
  write: async (operations) => { await KadeBook.bulkWrite(operations); },
  read: (filter) => KadeBook.find(filter, '_id description').lean(),
}));

router.get('/archive', requireJwtAuth, async (req, res) => {
  try {
    const hidden = libraryHiddenFrom(req); // the reviewer seat sees only its own uploads
    const child = await isChild(req);
    const at = cleanPath(req.query.path || '');
    const page = clampInt(req.query.page, 0, 100000, 0);
    const limit = clampInt(req.query.limit, 1, 200, 60);
    // the aggregate below does not cast strings to ObjectId the way find() does
    const ownerId = new mongoose.Types.ObjectId(String(req.user.id));
    const scope = req.query.scope === 'mine' ? 'mine' : 'public';
    const base = { state: 'ready', ...(hidden || scope === 'mine' ? { owner: ownerId } : { shared: true }), ...(child ? { grownUpsOnly: { $ne: true } } : {}) };
    const view = [{ $match: base }, { $addFields: { path: libraryPathExpression() } }];
    const prefix = at ? at + '/' : '';
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [folders, items, total] = await Promise.all([
      KadeBook.aggregate([
        ...view,
        { $match: { path: { $regex: '^' + escaped + '.+' } } },
        { $project: { seg: { $arrayElemAt: [{ $split: [{ $substrCP: ['$path', prefix.length, 400] }, '/'] }, 0] } } },
        { $group: { _id: '$seg', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $limit: 500 },
      ]),
      KadeBook.aggregate([...view, { $match: { path: at } }, { $sort: { title: 1, _id: 1 } }, { $skip: page * limit }, { $limit: limit }]),
      KadeBook.aggregate([...view, { $match: { path: at } }, { $count: 'count' }]).then((rows) => rows[0]?.count || 0),
    ]);
    const progress = items.length ? await KadeReadingProgress.find({ user: req.user.id, book: { $in: items.map((i) => i._id) } }).lean() : [];
    const pb = {}; for (const pr of progress) pb[String(pr.book)] = pr;
    res.json({ path: at, folders: folders.map((f) => ({ name: f._id, count: f.count, path: prefix + f._id })), items: items.map((b) => summary(b, pb[String(b._id)])), total, page, limit });
  } catch (e) {
    logger.error('[library/archive] error:', e);
    res.status(500).json({ error: 'Could not open that folder.' });
  }
});

router.get('/search', requireJwtAuth, async (req, res) => {
  try {
    const hidden = libraryHiddenFrom(req);
    const child = await isChild(req);
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (!q) return res.json({ items: [] });
    const base = { state: 'ready', ...(hidden || req.query.scope === 'mine' ? { owner: req.user.id } : { shared: true }), ...(child ? { grownUpsOnly: { $ne: true } } : {}) };
    const words = q.split(/\s+/).filter(Boolean).map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const page = clampInt(req.query.page, 0, 100000, 0);
    const items = await KadeBook.find({ ...base, $and: words.map((re) => ({ $or: [{ title: re }, { author: re }, { path: re }, { tags: re }, { 'meta.callSign': re }, { 'meta.brand': re }, { 'meta.market': re }] })) }).sort({ title: 1, _id: 1 }).skip(page * 100).limit(101).lean();
    const more = items.length > 100;
    if (more) items.pop();
    res.json({ items: items.map((b) => summary(b, null)), q, page, more });
  } catch (e) {
    res.status(500).json({ error: 'Search failed.' });
  }
});

/* ── THE LIBRARY'S EYES: video descriptions ─────────────────────────────── */
const describer = require('./kadeReadingRoomDescribe');

router.get('/book/:id/describe/:t/estimate', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    const t = clampInt(req.params.t, 0, 10000, 0);
    if (!book || !isMedia(book) || !(book.tracks || [])[t]) return res.status(404).json({ error: 'No such recording.' });
    const tr = book.tracks[t];
    const est = describer.estimate(tr.seconds || 0);
    res.json({ ok: true, enabled: describer.ENABLED(), ...est, hasSeconds: !!tr.seconds, queued: describer.queued(), progress: describer.progressOf(String(book.fileId || book._id), t), state: (tr.description || {}).state || '' });
  } catch (e) {
    res.status(500).json({ error: 'Could not estimate.' });
  }
});

/** Anyone who can open the item can ask for its description; the result is
 * stored on the item for everyone (one run serves the whole family). */
router.post('/book/:id/describe/:t', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    const t = clampInt(req.params.t, 0, 10000, 0);
    if (!book || !isMedia(book) || !(book.tracks || [])[t]) return res.status(404).json({ error: 'No such recording.' });
    const tr = book.tracks[t];
    if (!/^video\//.test(tr.mime || '')) return res.status(400).json({ error: 'That is a sound recording — there is nothing to see in it.' });
    const d = tr.description || {};
    if (d.state === 'done' && req.query.again !== '1') return res.json({ ok: true, state: 'done', description: d });
    if (d.state === 'working') return res.json({ ok: true, state: 'working', progress: describer.progressOf(String(book.fileId || book._id), t) });
    const signedUrl = await signGet(tr.key, tr.mime);
    /* The one-file rule: a shortcut's description is written on the file it reads (`fileId`), so one
     * run serves every shortcut; each shortcut's own copy of the track list is kept in step. */
    const bookId = String(book.fileId || book._id);
    await KadeBook.updateOne({ _id: bookId }, { $set: { [`tracks.${t}.description.state`]: 'working', [`tracks.${t}.description.error`]: '' } });
    const position = describer.enqueue({
      bookId, t, userId: req.user.id, signedUrl, mime: tr.mime, title: book.title, category: book.category,
      onDone: async (err, result) => {
        if (err) {
          await KadeBook.updateOne({ _id: bookId }, { $set: { [`tracks.${t}.description.state`]: 'failed', [`tracks.${t}.description.error`]: String(err.message || err).slice(0, 400), [`tracks.${t}.description.at`]: new Date() } });
          return;
        }
        const set = { [`tracks.${t}.description`]: { summary: result.summary, scenes: result.scenes, model: result.model, costUSD: result.costUSD, frames: result.frames, state: 'done', error: '', at: new Date() } };
        if (result.seconds && !tr.seconds) set[`tracks.${t}.seconds`] = result.seconds;
        await KadeBook.updateOne({ _id: bookId }, { $set: set });
        await KadeBook.updateMany({ shortcutOf: bookId, [`tracks.${t}.key`]: tr.key }, { $set: { [`tracks.${t}.description`]: set[`tracks.${t}.description`] } }).catch(() => {});
      },
    });
    logger.info(`[library/describe] user=${req.user.id} queued "${book.title}" track ${t} (position ${position})`);
    res.json({ ok: true, state: 'working', position });
  } catch (e) {
    logger.error('[library/describe] error:', e.message);
    res.status(500).json({ error: e.message || 'Could not start the description.' });
  }
});

router.get('/book/:id/describe/:t', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    const t = clampInt(req.params.t, 0, 10000, 0);
    if (!book || !isMedia(book) || !(book.tracks || [])[t]) return res.status(404).json({ error: 'No such recording.' });
    const d = book.tracks[t].description || {};
    res.json({ ok: true, state: d.state || '', progress: describer.progressOf(String(book.fileId || book._id), t), description: d.state ? d : null });
  } catch (e) {
    res.status(500).json({ error: 'Could not read the description.' });
  }
});


/* ── THE LIBRARIAN and "what just happened?" ────────────────────────────── */
const librarian = require('./kadeReadingRoomLibrarian');

router.post('/book/:id/librarian', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such item.' });
    const cur = book.librarian || {};
    if (cur.state === 'done' && req.query.again !== '1') return res.json({ ok: true, librarian: cur });
    if (cur.state === 'working') return res.json({ ok: true, librarian: cur });
    await KadeBook.updateOne({ _id: book._id }, { $set: { 'librarian.state': 'working', 'librarian.error': '' } });
    const bookId = String(book._id);
    setImmediate(async () => {
      try {
        const notes = await librarian.librarianNotes(book);
        await KadeBook.updateOne({ _id: bookId }, { $set: { librarian: { ...notes, state: 'done', error: '' } } });
        logKadeUsage({ userId: req.user.id, service: 'describe', quantity: 1, unit: 'items', costUSD: notes.costUSD, metadata: { source: 'librarian', book: bookId, model: notes.model, searches: notes.searches } });
        logger.info(`[library/librarian] "${book.title}": ${notes.confidence} — ${notes.identified || '(unidentified)'} $${notes.costUSD.toFixed(4)}`);
      } catch (e) {
        logger.warn(`[library/librarian] "${book.title}" FAILED: ${e.message}`);
        await KadeBook.updateOne({ _id: bookId }, { $set: { 'librarian.state': 'failed', 'librarian.error': String(e.message).slice(0, 300), 'librarian.at': new Date() } }).catch(() => {});
      }
    });
    res.json({ ok: true, librarian: { state: 'working' } });
  } catch (e) {
    res.status(500).json({ error: e.message || 'The librarian could not start.' });
  }
});

router.get('/book/:id/librarian', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such item.' });
    res.json({ ok: true, librarian: book.librarian || {} });
  } catch (e) {
    res.status(500).json({ error: 'Could not read the note.' });
  }
});

/** A recap of the last N minutes: queued like a description, cached on the track. */
router.post('/book/:id/recap/:t', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    const t = clampInt(req.params.t, 0, 10000, 0);
    if (!book || !isMedia(book) || !(book.tracks || [])[t]) return res.status(404).json({ error: 'No such recording.' });
    const tr = book.tracks[t];
    if (!/^video\//.test(tr.mime || '')) return res.status(400).json({ error: 'That is a sound recording — nothing to see.' });
    const to = Math.max(1, parseFloat((req.body || {}).to) || 0);
    const minutes = Math.min(30, Math.max(1, parseFloat((req.body || {}).minutes) || 5));
    const from = Math.max(0, to - minutes * 60);
    const cached = (tr.recaps || []).find((r) => Math.abs(r.to - to) < 20 && Math.abs(r.from - from) < 20);
    if (cached) return res.json({ ok: true, state: 'done', recap: cached });
    const signedUrl = await signGet(tr.key, tr.mime);
    const bookId = String(book.fileId || book._id); // a shortcut's recaps live on its file
    const position = describer.enqueue({
      bookId, t, from, to, userId: req.user.id, signedUrl, mime: tr.mime, title: book.title, category: book.category,
      onDone: async (err, result) => {
        if (err) return;
        const recap = { from, to, summary: result.summary, scenes: result.scenes, costUSD: result.costUSD, at: new Date() };
        await KadeBook.updateOne({ _id: bookId }, { $push: { [`tracks.${t}.recaps`]: { $each: [recap], $slice: -5 } } });
      },
    });
    res.json({ ok: true, state: 'working', position, from, to });
  } catch (e) {
    logger.error('[library/recap] error:', e.message);
    res.status(500).json({ error: e.message || 'Could not start the recap.' });
  }
});

router.get('/book/:id/recap/:t', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    const t = clampInt(req.params.t, 0, 10000, 0);
    if (!book || !isMedia(book) || !(book.tracks || [])[t]) return res.status(404).json({ error: 'No such recording.' });
    const to = parseFloat(req.query.to) || 0;
    const from = parseFloat(req.query.from) || 0;
    const recaps = book.tracks[t].recaps || [];
    const hit = recaps.find((r) => Math.abs(r.to - to) < 20 && Math.abs(r.from - from) < 20);
    const fileId = String(book.fileId || book._id);
    res.json({ ok: true, state: hit ? 'done' : (describer.progressOf(fileId, t) ? 'working' : ''), progress: describer.progressOf(fileId, t), recap: hit || null });
  } catch (e) {
    res.status(500).json({ error: 'Could not read the recap.' });
  }
});

router.post('/book/:id/ask/:t', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    const t = clampInt(req.params.t, 0, 10000, 0);
    if (!book) return res.status(404).json({ error: 'No such item.' });
    const tr = isMedia(book) ? (book.tracks || [])[t] : null;
    const b = req.body || {};
    const question = String(b.question || '').trim();
    if (!question) return res.status(400).json({ error: 'Ask something first.' });
    const to = parseFloat(b.to) || 0, from = parseFloat(b.from) || 0;
    const recap = tr ? (tr.recaps || []).find((r) => Math.abs(r.to - to) < 20 && Math.abs(r.from - from) < 20) || (tr.recaps || [])[tr.recaps.length - 1] : null;
    const r = await librarian.ask({ item: book, track: tr, question, recap, fromSeconds: recap ? recap.from : from, toSeconds: to || (recap ? recap.to : 0) });
    logKadeUsage({ userId: req.user.id, service: 'describe', quantity: 1, unit: 'items', costUSD: r.costUSD, metadata: { source: 'ask', book: String(book._id), model: r.model } });
    res.json({ ok: true, answer: r.answer });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not answer.' });
  }
});


/* ── SUBMISSIONS: "for library consideration" ──────────────────────────── */
const { KadeLibrarySubmission } = require('~/models/kadeBook');
const subOut = (s) => ({ id: String(s._id), type: s.type || 'submission', user: String(s.user), userName: s.userName, url: s.url, title: s.title, note: s.note, book: s.book ? String(s.book) : null, suggestedPath: s.suggestedPath || '', suggestedCategory: s.suggestedCategory || '', status: s.status, decisionNote: s.decisionNote || '', decidedAt: s.decidedAt, fetchedAt: s.fetchedAt, createdAt: s.createdAt });

/** "This is on the wrong shelf." Anyone who can open an item may say so;
 * the librarian moves it with one tap (or the owner/librarian's own report
 * is applied at once). */
router.post('/book/:id/report', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such item.' });
    const b = req.body || {};
    const suggestedPath = cleanPath(b.path || '');
    const suggestedCategory = CATEGORIES.includes(String(b.category)) ? String(b.category) : '';
    const note = String(b.note || '').trim().slice(0, 2000);
    if (!suggestedPath && !suggestedCategory && !note) return res.status(400).json({ error: 'Say where it belongs, or what is wrong.' });
    const userName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    if (canManage(req, book) && (suggestedPath || suggestedCategory)) {
      const set = {};
      if (suggestedPath) set.path = suggestedPath;
      if (suggestedCategory && book.kind !== 'text') set.category = suggestedCategory;
      await KadeBook.updateOne({ _id: book._id }, { $set: set });
      logger.info(`[library/report] ${userName} moved own "${book.title}" -> ${suggestedPath || suggestedCategory}`);
      return res.json({ ok: true, applied: true });
    }
    const s = await KadeLibrarySubmission.create({ user: req.user.id, userName, type: 'report', book: book._id, title: book.title, note, suggestedPath, suggestedCategory });
    logger.info(`[library/report] ${userName} says "${book.title}" belongs in ${suggestedPath || suggestedCategory || '(see note)'}`);
    refreshLibrarianDigest();
    res.json({ ok: true, applied: false, submission: subOut(s.toObject()) });
  } catch (e) {
    logger.error('[library/report] error:', e);
    res.status(500).json({ error: 'Could not send that.' });
  }
});

async function notifyUser(userId, text, userName) {
  try {
    const { deliverNudge } = require('~/server/services/kadeNudges');
    await deliverNudge(String(userId), text, { type: 'reminder', userName: userName || '' });
  } catch (e) {
    logger.warn(`[library/submissions] notify failed: ${e.message}`);
  }
}
/* THE LIBRARIAN'S DIGEST (Sep 24 2026). Every upload, request and shelf report
 * used to queue its own chat note for Kade; Amber bulk-uploading Bookshare
 * books buried two librarian replies under an approval pile, and neither reply
 * ran the catalog search it was asked for. Now each admin has at most ONE
 * waiting note that says what is waiting, rewritten in place while it waits
 * and removed once nothing does; after one is picked up, the next is not made
 * for LIBRARY_DIGEST_HOURS (6). Chat only, never a phone push or call.
 * Trusted uploads never reach it: they are not waiting for anyone. */
const LIBRARY_DIGEST = 'library-digest';
const LIBRARY_DIGEST_GAP_MS = () => Math.max(0, parseFloat(process.env.KADE_LIBRARY_DIGEST_HOURS) || 6) * 3600000;
/** The old one-per-item notes, folded into the digest the first time it runs. */
const LEGACY_LIBRARY_NOTE = /Open the Library page to (?:approve or decline it|move it or leave it)\.$/;
let digestRun = Promise.resolve();
function refreshLibrarianDigest({ create = true } = {}) {
  digestRun = digestRun.then(async () => {
    try {
      const { pendingLibraryDigest } = require('@librechat/api');
      const { KadePendingNudge } = require('~/models/kadeNudge');
      const { User } = require('~/db/models');
      const text = await pendingLibraryDigest({ books: KadeBook, submissions: KadeLibrarySubmission });
      const admins = await User.find({ role: 'ADMIN' }, '_id').lean();
      for (const a of admins) {
        const legacy = await KadePendingNudge.updateMany({ userId: a._id, deliveredAt: null, type: 'reminder', text: LEGACY_LIBRARY_NOTE }, { $set: { deliveredAt: new Date() } });
        const waiting = await KadePendingNudge.findOne({ userId: a._id, type: LIBRARY_DIGEST, deliveredAt: null });
        if (waiting) {
          if (!text) await KadePendingNudge.deleteOne({ _id: waiting._id, deliveredAt: null });
          else if (waiting.text !== text) await KadePendingNudge.updateOne({ _id: waiting._id, deliveredAt: null }, { $set: { text } });
          continue;
        }
        // Folded per-item notes are replaced by one digest, even on a refresh that would not start one.
        if (!(create || (legacy && legacy.modifiedCount > 0)) || !text) continue;
        // The quiet time runs from when she heard the last one, not from when it was written.
        if (await KadePendingNudge.exists({ userId: a._id, type: LIBRARY_DIGEST, deliveredAt: { $gt: new Date(Date.now() - LIBRARY_DIGEST_GAP_MS()) } })) continue;
        await KadePendingNudge.create({ userId: a._id, text, type: LIBRARY_DIGEST, channel: 'chat' });
      }
    } catch (e) {
      logger.warn(`[library/digest] refresh failed: ${e.message}`);
    }
  });
  return digestRun;
}
/* Once at startup: the per-item notes queued before this code shipped fold into
 * one digest right away. Trusted uploads never refresh, so without this they
 * would keep reaching Kade five a turn until someone else's request came in. */
function refreshLibrarianDigestOnStartup(connection = mongoose.connection) {
  const run = () => {
    const timer = setTimeout(() => refreshLibrarianDigest({ create: false }), 15000);
    if (timer && timer.unref) timer.unref();
  };
  if (connection.readyState === 1) run();
  else connection.once('open', run);
}
refreshLibrarianDigestOnStartup();

router.post('/submissions', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const url = String(b.url || '').trim().slice(0, 2000);
    const title = String(b.title || '').trim().slice(0, 300);
    const note = String(b.note || '').trim().slice(0, 2000);
    let book = null, item = null;
    if (b.book && isId(b.book)) {
      item = await KadeBook.findOne({ _id: b.book, owner: req.user.id }).lean();
      if (item) book = item._id;
    }
    if (!url && !book) return res.status(400).json({ error: 'Give a link, or donate a file first and submit that.' });
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'That does not look like a link. It should start with http.' });
    /* A trusted uploader's own FILE goes straight in (Sep 24 2026): shared now
     * if it is finished, or already shared and going in when its upload lands.
     * A link still waits for Kade, since approving one sends it to TubeVault. */
    const approved = !!item && (item.state === 'ready' || item.shared === true) && canPublish(req);
    if (!approved) {
      const open = await KadeLibrarySubmission.countDocuments({ user: req.user.id, status: 'pending' });
      if (open >= 50) return res.status(400).json({ error: 'You have fifty submissions waiting already — give the librarian a minute.' });
    }
    const userName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    if (approved) await settleTrustedSubmissions(req, [book]);
    const s = await KadeLibrarySubmission.create({ user: req.user.id, userName, url, title, note, book,
      ...(approved ? { status: 'approved', decidedAt: new Date(), decisionNote: isAdmin(req) ? '' : require('@librechat/api').trustedApprovalNote } : {}),
    });
    if (approved && !item.shared) await KadeBook.updateOne({ _id: book, owner: req.user.id, state: 'ready' }, { $set: { shared: true, sharedAt: new Date() } });
    logger.info(`[library/submissions] ${userName} submitted ${url || 'file ' + book} "${title}"${approved ? ' (shared at once)' : ''}`);
    if (!approved) refreshLibrarianDigest();
    res.json({ ok: true, submission: subOut(s.toObject()) });
  } catch (e) {
    logger.error('[library/submissions] error:', e);
    res.status(500).json({ error: 'Could not submit that.' });
  }
});

/** Mine; for a librarian (ADMIN) everyone's, filterable. TubeVault's Cloud
 * tab asks for status=approved&unfetched=1. */
router.get('/submissions', requireJwtAuth, async (req, res) => {
  try {
    const admin = isAdmin(req);
    const q = admin && req.query.all !== '0' ? {} : { user: req.user.id };
    if (req.query.status && ['pending', 'approved', 'rejected'].includes(String(req.query.status))) q.status = String(req.query.status);
    if (req.query.unfetched === '1') { q.fetchedAt = { $exists: false }; q.url = { $ne: '' }; }
    const rows = await KadeLibrarySubmission.find(q).sort({ createdAt: -1 }).limit(300).lean();
    res.json({ submissions: rows.map(subOut), librarian: admin });
  } catch (e) {
    res.status(500).json({ error: 'Could not list submissions.' });
  }
});

router.post('/submissions/:id/decide', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian decides.' });
    if (!isId(req.params.id)) return res.status(404).json({ error: 'No such submission.' });
    const s = await KadeLibrarySubmission.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'No such submission.' });
    const b = req.body || {};
    const status = b.status === 'approved' ? 'approved' : b.status === 'rejected' ? 'rejected' : null;
    if (!status) return res.status(400).json({ error: 'approved or rejected.' });
    s.status = status;
    s.decisionNote = String(b.note || '').trim().slice(0, 1000);
    s.decidedBy = req.user.id;
    s.decidedAt = new Date();
    await s.save();
    if (status === 'approved' && s.book && s.type === 'report') {
      const set = {};
      if (s.suggestedPath) set.path = s.suggestedPath;
      if (s.suggestedCategory) set.category = s.suggestedCategory;
      if (Object.keys(set).length) await KadeBook.updateOne({ _id: s.book, kind: s.suggestedCategory ? { $ne: 'text' } : { $exists: true } }, { $set: set });
    } else if (status === 'approved' && s.book) {
      await KadeBook.updateOne({ _id: s.book }, { $set: { shared: true, sharedAt: new Date() } });
    }
    const what = s.title || s.url || 'your file';
    if (s.type === 'report') {
      notifyUser(s.user, status === 'approved'
        ? `Thanks — "${what}" was moved${s.suggestedPath ? ' to ' + s.suggestedPath : ''}${s.suggestedCategory ? ' (' + s.suggestedCategory + ')' : ''} as you suggested.${s.decisionNote ? ' The librarian says: ' + s.decisionNote : ''}`
        : `"${what}" stays where it is for now.${s.decisionNote ? ' The librarian says: ' + s.decisionNote : ''}`, s.userName);
    } else notifyUser(s.user, status === 'approved'
      ? `Your library submission "${what}" was approved${s.url ? ' — it will be fetched into the collection' : ' and is in the family library now'}.${s.decisionNote ? ' The librarian says: ' + s.decisionNote : ''}`
      : `Your library submission "${what}" was not added this time.${s.decisionNote ? ' The librarian says: ' + s.decisionNote : ''}`, s.userName);
    logger.info(`[library/submissions] ${status}: "${what}" from ${s.userName}`);
    refreshLibrarianDigest({ create: false });
    res.json({ ok: true, submission: subOut(s.toObject()) });
  } catch (e) {
    logger.error('[library/submissions/decide] error:', e);
    res.status(500).json({ error: 'Could not record that decision.' });
  }
});

router.post('/submissions/:id/fetched', requireJwtAuth, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    if (!isId(req.params.id)) return res.status(404).json({ error: 'No such submission.' });
    await KadeLibrarySubmission.updateOne({ _id: req.params.id }, { $set: { fetchedAt: new Date() } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not mark it.' });
  }
});

router.delete('/submissions/:id', requireJwtAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'No such submission.' });
    const q = isAdmin(req) ? { _id: req.params.id } : { _id: req.params.id, user: req.user.id, status: 'pending' };
    const r = await KadeLibrarySubmission.deleteOne(q);
    if (r.deletedCount) refreshLibrarianDigest({ create: false });
    res.json({ ok: true, removed: r.deletedCount || 0 });
  } catch (e) {
    res.status(500).json({ error: 'Could not withdraw it.' });
  }
});


/* ── MANAGING: edit, move, delete — yours only, everything for the librarian
 * (Part 181 continued, her word: "reorganise and delete … change the status
 * … people who upload/submit should be able to control their own … but
 * nobody else's"). */
const canManage = (req, item) => item && (String(item.owner) === String(req.user.id) || isAdmin(req));

router.post('/book/:id/edit', requireJwtAuth, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'No such item.' });
    const item = await KadeBook.findById(req.params.id);
    if (!item || !canManage(req, item)) return res.status(404).json({ error: 'No such item of yours.' });
    const b = req.body || {};
    const changed = [];
    if (typeof b.title === 'string' && b.title.trim()) { item.title = b.title.trim().slice(0, 200); changed.push('title'); }
    if (typeof b.author === 'string') { item.author = b.author.trim().slice(0, 200); changed.push('author'); }
    if (typeof b.year === 'string') { item.copyrightYear = b.year.trim().slice(0, 12); changed.push('year'); }
    if (typeof b.description === 'string') { item.description = b.description.trim().slice(0, 2000); if (item.kind !== 'text') item.synopsis = item.description; changed.push('description'); }
    if (typeof b.category === 'string' && CATEGORIES.includes(b.category) && !(b.category === 'book' && item.kind !== 'text')) { item.category = b.category; changed.push('category'); }
    if (typeof b.path === 'string') { item.path = cleanPath(b.path); changed.push('folder'); }
    if (typeof b.path !== 'string' && typeof b.title === 'string') Object.assign(item, refineMediaFiling(item) || {});
    if (typeof b.shared === 'boolean' && (canPublish(req) || b.shared === false)) { if (b.shared && item.state !== 'ready') return res.status(400).json({ error: 'Add a recording before sharing it.' }); item.shared = b.shared; if (b.shared) item.sharedAt = new Date(); changed.push(b.shared ? 'shared' : 'private'); }
    if (typeof b.grownUpsOnly === 'boolean') { item.grownUpsOnly = b.grownUpsOnly; changed.push('grown-ups'); }
    if (Array.isArray(b.tags)) { item.tags = b.tags.slice(0, 30).map((t) => String(t).slice(0, 60)); changed.push('tags'); }
    if (Array.isArray(b.trackTitles) && item.tracks) b.trackTitles.forEach((t, i) => { if (item.tracks[i] && typeof t === 'string' && t.trim()) item.tracks[i].title = t.trim().slice(0, 200); });
    await item.save();
    if (b.shared === true && item.shared) await settleTrustedSubmissions(req, [item._id]);
    // The one-file rule: a file marked grown-ups only takes its shortcuts with it (rule 8).
    if (b.grownUpsOnly === true) await libraryFiles.propagateGrownUps([item._id]);
    logger.info(`[library/edit] user=${req.user.id} "${item.title}" ${changed.join(',') || 'nothing'}`);
    res.json({ ok: true, item: summary(item.toObject(), null) });
  } catch (e) {
    logger.error('[library/edit] error:', e);
    res.status(500).json({ error: 'Could not save those changes.' });
  }
});

/** Move or rename a whole archive folder (everything under `from`). Yours
 * only; the librarian moves everyone's. */
router.post('/archive/move-folder', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const from = cleanPath(b.from), to = cleanPath(b.to);
    if (!from || !to) return res.status(400).json({ error: 'Say which folder and where it goes.' });
    if (to === from || to.startsWith(from + '/')) return res.status(400).json({ error: 'A folder cannot move into itself.' });
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const q = { $expr: { $regexMatch: { input: libraryPathExpression(), regex: '^' + escaped + '(/|$)' } }, ...(isAdmin(req) ? {} : { owner: req.user.id }) };
    const items = await KadeBook.find(q, '_id path kind category').lean();
    if (!items.length) return res.status(404).json({ error: 'No items of yours in that folder.' });
    const ops = items.map((it) => ({ updateOne: { filter: { _id: it._id, path: it.path }, update: { $set: { path: to + libraryPath(it).slice(from.length) } } } }));
    await KadeBook.bulkWrite(ops);
    logger.info(`[library/move-folder] user=${req.user.id} "${from}" -> "${to}" (${items.length} items)`);
    res.json({ ok: true, moved: items.length, to });
  } catch (e) {
    logger.error('[library/move-folder] error:', e);
    res.status(500).json({ error: 'Could not move that folder.' });
  }
});

/** Several items at once: move, share, unshare, grown-ups, delete. */
router.post('/archive/batch', requireJwtAuth, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(isId).slice(0, 500);
    if (!ids.length) return res.status(400).json({ error: 'Pick some items first.' });
    const q = { _id: { $in: ids }, ...(isAdmin(req) ? {} : { owner: req.user.id }) };
    const action = String(b.action || '');
    let r;
    if (action === 'move') r = await KadeBook.updateMany(q, { $set: { path: cleanPath(b.to) } });
    else if (action === 'share') { if (!canPublish(req)) return res.status(403).json({ error: 'Only the librarian puts things in the family library. Use "Submit this for the library" instead.' }); r = await KadeBook.updateMany({ ...q, state: 'ready' }, { $set: { shared: true, sharedAt: new Date() } }); if (!isAdmin(req)) await settleTrustedSubmissions(req, (await KadeBook.find({ ...q, state: 'ready' }, '_id').lean()).map((it) => it._id)); }
    else if (action === 'unshare') r = await KadeBook.updateMany(q, { $set: { shared: false } });
    else if (action === 'grownups') {
      r = await KadeBook.updateMany(q, { $set: { grownUpsOnly: b.value !== false } });
      if (b.value !== false) await libraryFiles.propagateGrownUps((await KadeBook.find(q, '_id').lean()).map((it) => it._id));
    }
    else if (action === 'category' && CATEGORIES.includes(String(b.value))) r = await KadeBook.updateMany({ ...q, kind: { $ne: 'text' } }, { $set: { category: String(b.value) } });
    else if (action === 'delete') {
      const items = await KadeBook.find(q).lean();
      const gone = new Set(items.map((it) => String(it._id)));
      /* The one-file rule: a withdrawn file hands itself to its owner's oldest shortcut that stays
       * (and its text with it); shortcuts other people made to it go with it; and a stored object
       * goes only when no row left lists it. A text book's original goes too now (it used to stay on
       * B2 for good). */
      const promoted = new Set();
      for (const it of items) {
        const heir = await libraryFiles.promoteShortcuts(it, { except: gone });
        if (heir) promoted.add(String(it._id));
      }
      const foreign = (await libraryFiles.foreignShortcuts(items)).filter((id) => !gone.has(String(id)));
      const del = [...items.map((it) => it._id), ...foreign];
      const keys = items.flatMap((it) => [...(it.tracks || []).map((t) => t.key), it.fileKey || keyFromFileUrl(it.fileUrl)]).filter(Boolean);
      const texts = del.filter((id) => !promoted.has(String(id)));
      await Promise.all([KadeBookText.deleteMany({ book: { $in: texts } }), KadeReadingProgress.deleteMany({ book: { $in: del } }), KadeReadingBookmark.deleteMany({ book: { $in: del } }), KadeBook.deleteMany({ _id: { $in: del } })]);
      libraryFiles.releaseKeys(keys, { except: del }).catch(() => {});
      r = { modifiedCount: items.length };
    } else return res.status(400).json({ error: 'Unknown action.' });
    logger.info(`[library/batch] user=${req.user.id} ${action} ${r.modifiedCount || 0}/${ids.length}`);
    res.json({ ok: true, changed: r.modifiedCount || 0 });
  } catch (e) {
    logger.error('[library/batch] error:', e);
    res.status(500).json({ error: 'Could not do that.' });
  }
});

/* ── THE LIBRARIAN SORTS THE BOOKS ─────────────────────────────────────── */
router.post(['/librarian/refile-commercials', '/librarian/refile-books'], requireJwtAuth, express.json({ limit: '128kb' }), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.filter((id) => mongoose.isValidObjectId(id)).slice(0, 5000) : [];
    const books = req.path.endsWith('refile-books');
    const query = { state: 'ready', ...(books ? { kind: 'text' } : { path: /\/Commercials\/Other Commercials(?:\/|$)/i }), ...(ids.length ? { _id: { $in: ids } } : {}) };
    const items = await KadeBook.find(query, '_id title author path originalPath kind category shared owner tags').sort({ _id: 1 }).limit(10000).lean();
    const changes = items.flatMap((item) => {
      const shelf = books && correctedBookShelf(item.title, item.author, item.path);
      const filing = !books && refineMediaFiling(item);
      const to = books ? (shelf ? 'Books/' + shelf : null) : filing?.path;
      return to && to !== item.path ? [{ id: String(item._id), title: item.title, from: item.path, to, categoryFrom: item.category, categoryTo: filing?.category || item.category, originalPath: item.originalPath, shared: item.shared, owner: String(item.owner), tags: item.tags || [] }] : [];
    });
    const changedIds = new Set(changes.map((c) => c.id));
    if (b.apply !== true) return res.json({ ok: true, scanned: items.length, changes, ...(b.includeUnmatched === true ? { unmatched: items.filter((item) => !changedIds.has(String(item._id))).map((item) => ({ id: String(item._id), title: item.title, path: item.path, kind: item.kind })) } : {}) });
    if (!ids.length) return res.status(400).json({ error: 'Preview the changes first, then send their item IDs.' });
    const result = changes.length ? await KadeBook.bulkWrite(changes.map((c) => ({ updateOne: { filter: { _id: c.id, path: c.from, category: c.categoryFrom, state: 'ready' }, update: { $set: { path: c.to, ...(!books ? { category: c.categoryTo } : {}), ...(books ? { tags: [...c.tags.filter((t) => t !== c.from.replace(/^Books\//, '')), c.to.replace(/^Books\//, '')] } : {}) } } } }))) : { modifiedCount: 0 };
    logger.info(`[library/refile] corrected ${result.modifiedCount} commercial shelves`);
    res.json({ ok: true, changed: result.modifiedCount, changes });
  } catch (e) { logger.warn(`[library/refile] ${e.message}`); res.status(500).json({ error: 'Could not refile those commercials.' }); }
});
const sorter = require('./kadeReadingRoomSort');
const { zoneOf: mediaZoneOf } = require('~/server/services/kadeMediaLibrarian');
/* The librarian's location doubts, as the media sweep writes them into meta.review. */
const LOCATION_DOUBT = /(?:Space review: local to another area|Jev review: Missouri \([^)]*\), unsure if local)(?: \(\d(?:\.\d+)?\))?\.\s*/g;
const LOCATION_DOUBT_ANY = /Space review: local to another area|unsure if local/;
const withoutLocationDoubt = (review) => String(review || '').replace(LOCATION_DOUBT, '').trim();
router.get('/librarian/inventory', requireJwtAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
  try {
    const after = String(req.query.after || '');
    if (after && !isId(after)) return res.status(400).json({ error: 'Invalid cursor.' });
    const limit = clampInt(req.query.limit, 1, 2000, 1000);
    const items = await KadeBook.find({ state: 'ready', $or: [{ shared: true }, { owner: req.user.id }], ...(after ? { _id: { $gt: after } } : {}) }, '_id title author synopsis description path originalPath kind category shared grownUpsOnly owner tags meta tracks.seconds tracks.bytes tracks.sha256 fileBytes fileSha256 shortcutOf').sort({ _id: 1 }).limit(limit + 1).lean();
    const more = items.length > limit;
    if (more) items.pop();
    /* Part 278, continued: each item's total length, so TubeVault's "already in the
     * library" check can tell a 90-minute described film from the 15-minute read-along
     * cassette that shares its title. The per-track list stays out of the answer. */
    /* Sep 25 2026, the one-file rule: each item's stored size and SHA-256 (the first track's, or a
     * book's original), so TubeVault can skip exactly-the-same files locally; shortcuts say so. */
    for (const it of items) {
      const tracks = Array.isArray(it.tracks) ? it.tracks : [];
      it.seconds = Math.round(tracks.reduce((n, t) => n + (Number(t && t.seconds) || 0), 0));
      it.bytes = tracks.length ? tracks.reduce((n, t) => n + (Number(t && t.bytes) || 0), 0) : Number(it.fileBytes) || 0;
      it.sha256 = tracks.length === 1 ? String(tracks[0].sha256 || '') : !tracks.length ? String(it.fileSha256 || '') : '';
      if (tracks.length > 1) it.files = tracks.map((t) => ({ bytes: Number(t && t.bytes) || 0, sha256: String((t && t.sha256) || '') }));
      it.grownUpsOnly = !!it.grownUpsOnly;
      it.shortcutOf = it.shortcutOf ? String(it.shortcutOf) : null;
      delete it.tracks;
      delete it.fileBytes;
      delete it.fileSha256;
    }
    res.json({ items, next: more ? String(items[items.length - 1]._id) : null });
  } catch (e) { logger.warn(`[library/inventory] ${e.message}`); res.status(500).json({ error: 'Could not read the catalog.' }); }
});
/* Part 291: Kade's maintenance tools may send reviewed moves too (x-kade-ops-secret); they act as
 * nobody, so they reach shared rows only. */
router.post('/librarian/organize', opsOrAdmin(isAdmin), express.json({ limit: '1mb' }), async (req, res) => {
  if (!req.kadeOps && !isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
  let operations;
  try { operations = reviewedLibraryMoves(req.body?.moves, CATEGORIES); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    for (const op of operations) {
      op.updateOne.filter.$or = req.user ? [{ shared: true }, { owner: req.user.id }] : [{ shared: true }];
      /* Part 282: a repaired title is new evidence. An item still waiting for a folder loses the
       * librarian's "already read" mark, so the next pass reads it again under its real name. */
      const set = op.updateOne.update.$set;
      if (set.title !== undefined && mediaZoneOf({ kind: op.updateOne.filter.kind, path: set.path }) === 'intake') {
        op.updateOne.update.$unset = { 'meta.jevFiling': '', 'meta.jevFilingTries': '' };
      }
    }
    const result = await KadeBook.bulkWrite(operations);
    /* Part 283 (Sep 24 2026), her words: "If it's from STL, put it in stl. I noticed there are a lot of
     * local car dealers and stuff that don't know if they're local to here or not like don brown".
     * A recording moved onto her own shelves (Missouri, the Ozarks) is local to here, so the
     * librarian's location doubts come off it; any other flag stays. Don Brown Chevrolet (2244 S.
     * Kingshighway) had been flagged "local to another area (0.89)", a deletion suggestion. */
    const home = operations.filter((op) => mediaZoneOf({ kind: op.updateOne.filter.kind, path: op.updateOne.update.$set.path }) === 'local');
    let cleared = 0;
    if (home.length) {
      const docs = await KadeBook.find({ _id: { $in: home.map((op) => op.updateOne.filter._id) }, 'meta.review': LOCATION_DOUBT_ANY }, '_id kind path meta.review').lean();
      const fixes = docs.filter((d) => mediaZoneOf(d) === 'local').map((d) => ({
        updateOne: { filter: { _id: d._id, 'meta.review': d.meta.review }, update: { $set: { 'meta.review': withoutLocationDoubt(d.meta.review) } } },
      }));
      if (fixes.length) cleared = (await KadeBook.bulkWrite(fixes)).modifiedCount || 0;
    }
    logger.info(`[library/organize] user=${req.user ? req.user.id : 'ops'} matched=${result.matchedCount} changed=${result.modifiedCount} doubtsCleared=${cleared}`);
    res.json({ ok: true, matched: result.matchedCount, changed: result.modifiedCount, doubtsCleared: cleared });
  } catch (e) { logger.warn(`[library/organize] ${e.message}`); res.status(500).json({ error: 'Could not apply the reviewed changes.' }); }
});

/* ── JEV FILES THE CATCH-ALL COMMERCIALS (Part 237, Sep 20 2026) ─────────
 * Kade: "organise my backblaze library." Part 185 filed what its brand lists
 * could name and left 4,864 in `Commercials/Other Commercials/<decade>` with
 * "unknown titles were not guessed". Jev knows what Tegrin and Toast'em are.
 *
 * POST /librarian/jev-file-ads   { apply?: true, limit?: n, decade?: '1980s' }
 *   apply omitted → a preview: every move Jev would make, nothing written.
 *   apply: true   → the moves are applied, guarded on the path they came from.
 *
 * WHAT IT WILL NOT DO. It only ever renames the product folder inside
 * `Commercials/`; the decade and everything above it are copied from the path
 * the item already had, because Jev is weak at dates and is never asked for
 * one. It touches nothing but `path` — never sharing, never the owner, never
 * `grownUpsOnly`, never a file on B2. `originalPath` is untouched, so every
 * move can be read back and undone. Items Jev is not sure of stay exactly
 * where they are, which is no worse than today.
 *
 * TRIAL (Sep 20 2026, live API, 60 real titles off this catalog, scratchpad
 * jev_ads_trial2.js): at the 0.70 floor 34 of 60 filed and the filings were
 * right — Tourister to Clothing (luggage), Arm & Hammer to Cleaning, Stax to
 * Music, Bendix Brakes to Auto, Team Flakes to Cereal. The floor is where the
 * quality is: below about 0.65 Jev starts guessing on obscure old brands and
 * guesses badly (Lever 2000 to "Cars and Trucks"). Two ways round that were
 * tried and BOTH FAILED — a brand join against the 20,222 already-filed
 * commercials matched only 8% and matched them wrongly ("Children's Palace",
 * a toy shop, onto "Children's Panadol" and into Medicine), and a second
 * yes/no asking Jev to confirm its own middling pick rejected the right
 * answers and let the worst wrong one through at 0.81. So roughly 2,100
 * obscure regional brands are past what Jev knows, and no amount of re-asking
 * gets at knowledge that is not there. They keep their decade folder and wait
 * for a human or a better model. */
router.post('/librarian/jev-file-ads', requireJwtAuth, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const judges = require('~/server/services/kadeJevJudges');
    const b = req.body || {};
    const limit = clampInt(b.limit, 1, 6000, 6000);
    const decade = typeof b.decade === 'string' && /^[\w -]{1,24}$/.test(b.decade) ? b.decade : null;
    const query = {
      state: 'ready',
      category: 'commercials',
      path: decade
        ? new RegExp(`/Commercials/Other Commercials/${decade.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
        : /\/Commercials\/Other Commercials(?:\/|$)/i,
    };
    const items = await KadeBook.find(query, '_id title path').sort({ _id: 1 }).limit(limit).lean();
    if (!items.length) return res.json({ ok: true, scanned: 0, moves: [], changed: 0 });
    const t0 = Date.now();
    const { moves, skipped, costUSD } = await judges.fileAds(items);
    logger.info(
      `[library/jev-ads] read ${items.length} → ${moves.length} filed, ${skipped.length} left, ${Date.now() - t0}ms, $${costUSD.toFixed(4)}`,
    );
    if (b.apply !== true) {
      return res.json({ ok: true, scanned: items.length, filed: moves.length, left: skipped.length, costUSD, moves: moves.slice(0, 400) });
    }
    /* Guarded on the path we read, so a move that raced an upload is a no-op
     * rather than a wrong write. */
    const result = moves.length
      ? await KadeBook.bulkWrite(
          moves.map((m) => ({
            updateOne: { filter: { _id: m.id, path: m.from, state: 'ready' }, update: { $set: { path: m.to } } },
          })),
        )
      : { modifiedCount: 0 };
    const byShelf = {};
    for (const m of moves) byShelf[m.category] = (byShelf[m.category] || 0) + 1;
    logger.info(`[library/jev-ads] applied ${result.modifiedCount}/${moves.length}`);
    res.json({ ok: true, scanned: items.length, filed: moves.length, left: skipped.length, changed: result.modifiedCount || 0, costUSD, byShelf });
  } catch (e) {
    logger.warn(`[library/jev-ads] ${e.message}`);
    res.status(500).json({ error: 'Could not file those commercials.' });
  }
});

/* THE LOCAL SHELF — Jev gives the Ozarks archive a shape you can walk
 * (Part 238, Sep 20 2026). Her ask, in her words: "My main expectation is
 * that people can find my local stuff quickly and easily, as far as ozarks
 * springfield missouri type stuff."
 *
 * 1,672 items live under `Video/Ozarks (Springfield Area)` in folders named
 * only for a decade, 1,207 of them in the one called 1990s. This asks Jev
 * what each item actually IS and puts a kind between the root and the decade,
 * so the walk becomes nine short lists instead of one list of twelve hundred.
 * The kinds are in `kadeJevJudges.LOCAL_KIND_CRITERIA` with the trial that
 * chose their wording.
 *
 * Same guards as the commercial filer and for the same reasons: preview
 * unless `apply:true`, a bulkWrite filtered on the path that was read so a
 * move that raced an upload is a no-op, and `path` is the only field written
 * — never sharing, never the owner, never `grownUpsOnly`, never a file on B2.
 * `originalPath` is untouched so every move can be read back and undone.
 *
 * Nothing ever leaves the Ozarks root and nothing loses its decade, so the
 * worst a wrong answer can do is put a local item on the wrong local shelf.
 * The `local` tag, `meta.callSign` and `author` are all untouched, and
 * /search already reads all three, so "Springfield", "KOLR" and "Ozarks"
 * keep finding everything they found before. */
router.post('/librarian/jev-file-local', requireJwtAuth, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const judges = require('~/server/services/kadeJevJudges');
    const b = req.body || {};
    const limit = clampInt(b.limit, 1, 3000, 3000);
    const decade = typeof b.decade === 'string' && /^[\w -]{1,24}$/.test(b.decade) ? b.decade : null;
    const root = judges.LOCAL_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* Only items sitting DIRECTLY in a decade folder — `[^/]+$` is what keeps
     * a second run from burrowing an already-filed item one level deeper. */
    const query = {
      state: 'ready',
      path: decade
        ? new RegExp(`^${root}/${decade.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
        : new RegExp(`^${root}/[^/]+$`, 'i'),
    };
    const items = await KadeBook.find(query, '_id title path author meta').sort({ _id: 1 }).limit(limit).lean();
    if (!items.length) return res.json({ ok: true, scanned: 0, moves: [], changed: 0 });
    const t0 = Date.now();
    const { moves, skipped, costUSD } = await judges.fileLocal(items);
    logger.info(
      `[library/jev-local] read ${items.length} → ${moves.length} filed, ${skipped.length} left, ${Date.now() - t0}ms, $${costUSD.toFixed(4)}`,
    );
    const byKind = {};
    for (const m of moves) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
    if (b.apply !== true) {
      return res.json({ ok: true, scanned: items.length, filed: moves.length, left: skipped.length, costUSD, byKind, moves: moves.slice(0, 400) });
    }
    const result = moves.length
      ? await KadeBook.bulkWrite(
          moves.map((m) => ({
            updateOne: { filter: { _id: m.id, path: m.from, state: 'ready' }, update: { $set: { path: m.to } } },
          })),
        )
      : { modifiedCount: 0 };
    logger.info(`[library/jev-local] applied ${result.modifiedCount}/${moves.length}`);
    res.json({ ok: true, scanned: items.length, filed: moves.length, left: skipped.length, changed: result.modifiedCount || 0, costUSD, byKind });
  } catch (e) {
    logger.warn(`[library/jev-local] ${e.message}`);
    res.status(500).json({ error: 'Could not file those local items.' });
  }
});

/* THE AUDIO SHELF — her radio collection, out of the drop folder
 * (Part 238, Sep 20 2026). Her rule this session: "audio and video will be
 * organised by category and decade whenever possible." The video is; the
 * audio never was. Every radio item was still sitting in
 * `./old radio ads from 90s 2000s` — the folder name as she dragged it in,
 * leading dot and all, not even under `Audio/`, with no decade recorded.
 *
 * This asks Jev what each recording IS before asking where it goes, because
 * three unlike things are mixed in there: real radio adverts, eighty spoof
 * adverts from Grand Theft Auto IV, and thirteen airchecks of which twelve
 * are Springfield stations. See `kadeJevJudges` section 1d for the trial and
 * for why the destination rules read the way they do.
 *
 * Same guards as the other two filers: preview unless `apply:true`, a
 * bulkWrite filtered on the path that was read, `path` the only field written,
 * `originalPath` untouched so every move can be read back and undone. */
router.post('/librarian/jev-file-audio', requireJwtAuth, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const judges = require('~/server/services/kadeJevJudges');
    const b = req.body || {};
    const limit = clampInt(b.limit, 1, 2000, 2000);
    /* Anything of kind audio that is not already on the Audio shelf. Written
     * as the absence of a prefix rather than as the one drop folder's name, so
     * the next folder she drags in is picked up without a code change. */
    const query = { state: 'ready', kind: 'audio', path: { $not: new RegExp(`^${judges.AUDIO_ROOT}/`) } };
    const items = await KadeBook.find(query, '_id title path meta').sort({ _id: 1 }).limit(limit).lean();
    if (!items.length) return res.json({ ok: true, scanned: 0, moves: [], changed: 0 });
    const t0 = Date.now();
    const { moves, skipped, costUSD } = await judges.fileAudio(items);
    logger.info(
      `[library/jev-audio] read ${items.length} → ${moves.length} filed, ${skipped.length} left, ${Date.now() - t0}ms, $${costUSD.toFixed(4)}`,
    );
    const byKind = {};
    for (const m of moves) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
    if (b.apply !== true) {
      return res.json({ ok: true, scanned: items.length, filed: moves.length, left: skipped.length, costUSD, byKind, moves: moves.slice(0, 400) });
    }
    const result = moves.length
      ? await KadeBook.bulkWrite(
          moves.map((m) => ({
            updateOne: { filter: { _id: m.id, path: m.from, state: 'ready' }, update: { $set: { path: m.to } } },
          })),
        )
      : { modifiedCount: 0 };
    logger.info(`[library/jev-audio] applied ${result.modifiedCount}/${moves.length}`);
    res.json({ ok: true, scanned: items.length, filed: moves.length, left: skipped.length, changed: result.modifiedCount || 0, costUSD, byKind });
  } catch (e) {
    logger.warn(`[library/jev-audio] ${e.message}`);
    res.status(500).json({ error: 'Could not file that audio.' });
  }
});

/* THE LAST 2,270, WITH EYES (Part 238, Sep 20 2026). Kade chose this route
 * when the options were put to her, at a quoted fifteen cents for all of them.
 * One frame from each commercial the text filer could not place, a short label
 * from a cheap vision model, and then the SAME Jev question that already knows
 * the 49 shelves. The eye names the product; Jev files it.
 *
 * OFF until `KADE_LIBRARY_VISION_FILE=1` is set, because unlike the other
 * filers this one spends real money at a vision model and pulls bytes out of
 * the bucket. Every run is bounded three ways: `limit` (60 by default, 400
 * ceiling), the dollar cap in `KADE_FRAME_RUN_USD_CAP`, and preview unless
 * `apply:true`. Same write guards as its siblings — path-filtered bulkWrite,
 * `path` the only field written, `originalPath` untouched.
 *
 * The response carries `seen` on every move so a person can read what the eye
 * reported before anything is applied. Read them. That is the whole point of
 * previewing a batch first. */
router.post('/librarian/vision-file-ads', requireJwtAuth, express.json({ limit: '16kb' }), async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const framer = require('./kadeReadingRoomFrameFile');
    if (!framer.ENABLED()) return res.status(409).json({ error: 'The vision filer is off. Set KADE_LIBRARY_VISION_FILE=1 to turn it on.' });
    const b = req.body || {};
    const limit = clampInt(b.limit, 1, 400, 60);
    const decade = typeof b.decade === 'string' && /^[\w -]{1,24}$/.test(b.decade) ? b.decade : null;
    const query = {
      state: 'ready',
      category: 'commercials',
      path: decade
        ? new RegExp(`/Commercials/Other Commercials/${decade.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
        : /\/Commercials\/Other Commercials(?:\/|$)/i,
    };
    const items = await KadeBook.find(query, '_id title path tracks').sort({ _id: 1 }).skip(clampInt(b.skip, 0, 100000, 0)).limit(limit).lean();
    if (!items.length) return res.json({ ok: true, scanned: 0, moves: [], changed: 0 });
    const t0 = Date.now();
    /* The route owns the bucket; the framer only knows how to look. */
    const signOf = async (it) => {
      const tr = (it.tracks || []).find((t) => /^video\//.test((t && t.mime) || ''));
      return tr && tr.key ? signGet(tr.key, tr.mime) : null;
    };
    const r = await framer.fileByFrame(items, { signOf });
    const costUSD = (r.visionUSD || 0) + (r.jevUSD || 0);
    logger.info(
      `[library/vision-ads] read ${items.length} → looked ${r.looked}, named ${r.labelled}, filed ${r.moves.length}, ${Date.now() - t0}ms, vision $${(r.visionUSD || 0).toFixed(4)} jev $${(r.jevUSD || 0).toFixed(4)}`,
    );
    const byShelf = {};
    for (const m of r.moves) byShelf[m.category] = (byShelf[m.category] || 0) + 1;
    const summary = {
      ok: true,
      scanned: items.length,
      looked: r.looked,
      named: r.labelled,
      filed: r.moves.length,
      left: r.skipped.length,
      visionUSD: r.visionUSD,
      jevUSD: r.jevUSD,
      costUSD,
      cappedAt: r.cappedAt || null,
      byShelf,
    };
    if (b.apply !== true) return res.json({ ...summary, moves: r.moves.slice(0, 200) });
    const result = r.moves.length
      ? await KadeBook.bulkWrite(
          r.moves.map((m) => ({
            updateOne: { filter: { _id: m.id, path: m.from, state: 'ready' }, update: { $set: { path: m.to } } },
          })),
        )
      : { modifiedCount: 0 };
    logger.info(`[library/vision-ads] applied ${result.modifiedCount}/${r.moves.length}`);
    res.json({ ...summary, changed: result.modifiedCount || 0 });
  } catch (e) {
    logger.warn(`[library/vision-ads] ${e.message}`);
    res.status(500).json({ error: 'Could not look at those commercials.' });
  }
});

router.post('/librarian/tubevault-hints', requireJwtAuth, express.json({ limit: '64kb' }), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
  if (!validTubeVaultItems(req.body?.items)) return res.status(400).json({ error: 'Supply 1 to 50 titles with station and rejected fields.' });
  const jev = require('~/server/services/kadeJev');
  if (!jev.enabled('KADE_JEV_TUBEVAULT')) return res.status(503).json({ error: 'Jev sorting is unavailable. Offline sorting still works.' });
  try {
    const result = await tubeVaultHints(req.body.items, jev.ask);
    logger.info(`[library/tubevault] hints=${result.hints.length} failed=${result.failed.length} inputTokens=${result.inputTokens}`);
    return res.json({ ok: true, ...result });
  } catch (e) {
    const limited = e.message === 'Busy' || e.message === 'Daily limit';
    if (limited) res.set('Retry-After', '60');
    return res.status(limited ? 429 : 500).json({ error: limited ? e.message : 'Could not prepare sorting hints.' });
  }
});

router.get('/librarian/sort-status', requireJwtAuth, async (req, res) => {
  try { res.json({ ok: true, enabled: sorter.ENABLED(), unsorted: await sorter.unsortedCount(), shelves: sorter.SHELVES }); } catch (e) { res.status(500).json({ error: 'Could not count.' }); }
});
router.post('/librarian/sort-books', requireJwtAuth, async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only the librarian.' });
    const filed = await sorter.sortOnce({ force: true, userId: req.user.id });
    res.json({ ok: true, filed, unsorted: await sorter.unsortedCount() });
  } catch (e) { res.status(500).json({ error: 'The sort did not run.' }); }
});
sorter.startSortSweep();
/* Part 270: the media librarian files new arrivals and audits the rest (routes/kadeReadingRoomMediaSweep.js). */
const mediaSweep = require('./kadeReadingRoomMediaSweep');
mediaSweep.mount(router, { requireJwtAuth, isAdmin, express });
mediaSweep.start();
/* Sep 25 2026 (her ask): how long leftovers stay on Backblaze. Report-only until KADE_STORAGE_KEEPER=on. */
const storageKeeper = require('~/server/services/kadeStorageKeeper');
storageKeeper.mount(router, { requireJwtAuth, isAdmin, express, s3, bucket: MEDIA_BUCKET });
storageKeeper.start({ s3, bucket: MEDIA_BUCKET });
/* The one-file rule's verifier: new uploads waiting to be compared (fileCheck.state 'pending'),
 * every 2 minutes; it also retires folded copies after their 30 days. */
setInterval(() => void libraryFiles.verifyPass().catch((e) => logger.warn(`[library/files] verifier: ${e.message}`)), 2 * 60 * 1000).unref();

/* ── THE ONE-FILE RULE: the librarian's maintenance (Sep 25 2026) ─────────
 * For an admin sign-in, or server to server with x-kade-ops-secret (middleware/kadeOpsSecret.js).
 * Nothing here merges or deletes without apply:true. The order that fits today's library:
 *   1. POST files/etags {apply}          tracks' ETags from one listing pass (no egress), and the
 *                                        stored original's key for books older than `fileKey`
 *   2. POST files/hash {limitGB?}        hash only files that share their exact size (daily GB cap);
 *                                        never merges. Runs in the background; GET files/hash reads it
 *   3. GET  duplicates                   every group with its plan and usage counts
 *   4. POST duplicates/merge {groups?, keepers?, confirmHeld?, plans?, apply}
 *                                        re-planned from the database; a group whose keeper changed is
 *                                        refused; held groups only when listed in confirmHeld (plans:
 *                                        { group: { keeper, action: 'merge'|'shortcut' } }); receipts
 *   5. POST duplicates/undo {receiptIds | all}   within 30 days
 *   POST books/merge {pairs:[{extra, keeper}], apply}   same text, different ZIP (Bookshare re-downloads)
 *   POST files/unreferenced {apply}      objects no row lists; only byte-identical copies older than a
 *                                        day may go */
const opsLibrarian = opsOrAdmin(isAdmin);
const opsBy = (req) => (req.kadeOps ? 'ops' : String(req.user && req.user.id));
const bodyApply = (req) => (req.body || {}).apply === true;
router.post('/librarian/files/etags', opsLibrarian, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const result = await libraryFiles.fillEtags({ apply: bodyApply(req) });
    logger.info(`[library/files/etags] ${bodyApply(req) ? 'applied' : 'preview'} by ${opsBy(req)}: ${result.listed} objects, ${result.tracksWithoutEtag} tracks without an ETag, ${result.written} written, ${result.fileKeys.fileKeys} book keys`);
    res.json({ ok: true, apply: bodyApply(req), mode: filesMode(), ...result });
  } catch (e) { logger.warn(`[library/files/etags] ${e.message}`); res.status(500).json({ error: 'Could not read the storage listing.' }); }
});
let hashRun = { running: false };
router.get('/librarian/files/hash', opsLibrarian, (_req, res) => res.json({ ok: true, ...hashRun, budget: libraryFiles.budget() }));
router.post('/librarian/files/hash', opsLibrarian, express.json({ limit: '2kb' }), async (req, res) => {
  if (hashRun.running) return res.status(409).json({ error: 'A hash pass is already running.', ...hashRun });
  const limitGB = parseFloat((req.body || {}).limitGB);
  const limitBytes = limitGB > 0 ? limitGB * 1024 ** 3 : Infinity;
  hashRun = { running: true, startedAt: new Date(), limitGB: limitGB > 0 ? limitGB : null, by: opsBy(req) };
  const run = libraryFiles.hashCollisions({ limitBytes })
    .then((result) => { hashRun = { ...hashRun, running: false, finishedAt: new Date(), result }; logger.info(`[library/files/hash] ${JSON.stringify(result)}`); })
    .catch((e) => { hashRun = { ...hashRun, running: false, finishedAt: new Date(), error: e.message }; logger.warn(`[library/files/hash] ${e.message}`); });
  if ((req.body || {}).wait === true) await run;
  res.status((req.body || {}).wait === true ? 200 : 202).json({ ok: true, ...hashRun, budget: libraryFiles.budget() });
});
router.get('/librarian/duplicates', opsLibrarian, async (_req, res) => {
  try {
    const groups = await libraryFiles.duplicateGroups();
    const extras = groups.reduce((n, g) => n + g.rows.length - 1, 0);
    res.json({ ok: true, mode: filesMode(), count: groups.length, held: groups.filter((g) => g.hold).length, extras, groups });
  } catch (e) { logger.warn(`[library/duplicates] ${e.message}`); res.status(500).json({ error: 'Could not list the duplicates.' }); }
});
router.get('/librarian/duplicates/receipts', opsLibrarian, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 86400000);
    const rows = await KadeLibraryFold.find({ createdAt: { $gte: since } }, '_id kind group keeper entries.id entries.action by undoneAt createdAt').sort({ createdAt: -1 }).limit(2000).lean();
    res.json({ ok: true, receipts: rows.map((r) => ({ id: String(r._id), kind: r.kind, group: r.group, keeper: String(r.keeper), rows: (r.entries || []).map((e) => ({ id: e.id, action: e.action })), by: r.by, undoneAt: r.undoneAt || null, createdAt: r.createdAt })) });
  } catch (e) { res.status(500).json({ error: 'Could not read the receipts.' }); }
});
router.post('/librarian/duplicates/merge', opsLibrarian, express.json({ limit: '1mb' }), async (req, res) => {
  const b = req.body || {};
  if (b.groups !== undefined && b.groups !== 'all' && !Array.isArray(b.groups)) return res.status(400).json({ error: "groups is 'all' or a list of group ids." });
  try {
    const result = await libraryFiles.mergeGroups({
      groups: b.groups === undefined ? 'all' : b.groups,
      keepers: b.keepers && typeof b.keepers === 'object' ? b.keepers : {},
      confirmHeld: Array.isArray(b.confirmHeld) ? b.confirmHeld : [],
      plans: b.plans && typeof b.plans === 'object' ? b.plans : {},
      apply: b.apply === true,
      limit: clampInt(b.limit, 1, 2000, 300),
      by: opsBy(req),
    });
    logger.info(`[library/duplicates/merge] ${b.apply === true ? 'applied' : 'preview'} by ${opsBy(req)}: ${result.applied.length} merged, ${result.preview.length} previewed, ${result.refused.length} refused${result.more ? ', more to do' : ''}`);
    res.json({ ok: true, apply: b.apply === true, ...result });
  } catch (e) { logger.warn(`[library/duplicates/merge] ${e.message}`); res.status(500).json({ error: 'Could not merge those duplicates.' }); }
});
router.post('/librarian/duplicates/undo', opsLibrarian, express.json({ limit: '256kb' }), async (req, res) => {
  const b = req.body || {};
  if (b.all !== true && !(Array.isArray(b.receiptIds) && b.receiptIds.length)) return res.status(400).json({ error: 'Send receiptIds, or all: true.' });
  try {
    const result = await libraryFiles.undoReceipts({ receiptIds: b.receiptIds || [], all: b.all === true });
    logger.info(`[library/duplicates/undo] by ${opsBy(req)}: ${result.undone.length} receipts put back`);
    res.json({ ok: true, ...result });
  } catch (e) { logger.warn(`[library/duplicates/undo] ${e.message}`); res.status(500).json({ error: 'Could not undo those merges.' }); }
});
router.post('/librarian/books/merge', opsLibrarian, express.json({ limit: '256kb' }), async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.pairs) || !b.pairs.length || b.pairs.length > 500) return res.status(400).json({ error: 'Send 1 to 500 pairs of { extra, keeper }.' });
  try {
    const result = await libraryFiles.mergeBooks({ pairs: b.pairs, apply: b.apply === true, by: opsBy(req) });
    logger.info(`[library/books/merge] ${b.apply === true ? 'applied' : 'preview'} by ${opsBy(req)}: ${result.applied.length} folded, ${result.ok.length} identical, ${result.refused.length} refused`);
    res.json({ ok: true, apply: b.apply === true, ...result });
  } catch (e) { logger.warn(`[library/books/merge] ${e.message}`); res.status(500).json({ error: 'Could not merge those books.' }); }
});
router.post('/librarian/files/unreferenced', opsLibrarian, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const result = await libraryFiles.unreferenced({ apply: bodyApply(req) });
    logger.info(`[library/files/unreferenced] ${bodyApply(req) ? 'applied' : 'report'} by ${opsBy(req)}: ${result.count} unreferenced (${result.gb} GB), ${result.identical} byte-identical, ${result.deleted} removed`);
    res.json({ ok: true, apply: bodyApply(req), ...result });
  } catch (e) { logger.warn(`[library/files/unreferenced] ${e.message}`); res.status(500).json({ error: 'Could not read the storage listing.' }); }
});

// Part 272: her uploads public unless she says private; a one-time share, off unless switched on.
require('~/server/services/kadeLibraryPublicDefault').start();

/* ── COLLECTIONS (playlists) ───────────────────────────────────────────── */
const collOut = (c) => ({ id: String(c._id), title: c.title, description: c.description || '', shared: !!c.shared, ownerName: c.ownerName || '', owner: String(c.owner), count: (c.items || []).length, updatedAt: c.updatedAt });

router.get('/collections', requireJwtAuth, async (req, res) => {
  try {
    const hidden = libraryHiddenFrom(req);
    const [mine, shared] = await Promise.all([
      KadeCollection.find({ owner: req.user.id }).sort({ updatedAt: -1 }).lean(),
      hidden ? [] : KadeCollection.find({ shared: true, owner: { $ne: req.user.id } }).sort({ updatedAt: -1 }).limit(200).lean(),
    ]);
    res.json({ mine: mine.map(collOut), shared: shared.map(collOut) });
  } catch (e) {
    res.status(500).json({ error: 'Could not load collections.' });
  }
});

router.post('/collections', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ error: 'Give the collection a name.' });
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const c = await KadeCollection.create({ owner: req.user.id, ownerName, title, description: String(b.description || '').slice(0, 1000), shared: b.shared === true });
    res.json({ ok: true, collection: collOut(c.toObject()) });
  } catch (e) {
    res.status(500).json({ error: 'Could not create it.' });
  }
});

async function openCollection(req, id) {
  if (!isId(id)) return null;
  const c = await KadeCollection.findById(id);
  if (!c) return null;
  if (String(c.owner) === String(req.user.id) || isAdmin(req)) return c;
  if (c.shared && !libraryHiddenFrom(req)) return c;
  return null;
}

router.get('/collections/:id', requireJwtAuth, async (req, res) => {
  try {
    const c = await openCollection(req, req.params.id);
    if (!c) return res.status(404).json({ error: 'No such collection.' });
    const child = await isChild(req);
    const ids = c.items.map((i) => i.book);
    /* Only items this reader could open on their own: theirs, or shared with a
     * family member. A collection must not carry someone's private item, or the
     * family shelf, to an account without access (Sep 24 2026). */
    const visible = isAdmin(req) ? {} : { $or: [{ owner: req.user.id }, ...(libraryHiddenFrom(req) ? [] : [{ shared: true }])] };
    const books = ids.length ? await KadeBook.find({ _id: { $in: ids }, state: 'ready', ...visible, ...(child ? { grownUpsOnly: { $ne: true } } : {}) }).lean() : [];
    const byId = {}; for (const bk of books) byId[String(bk._id)] = bk;
    const items = c.items.map((i, n) => {
      const bk = byId[String(i.book)];
      if (!bk) return null;
      const tr = (bk.tracks || [])[i.track] || null;
      return { n, book: summary(bk, null), track: i.track, trackTitle: tr ? tr.title : '', title: i.title || bk.title, mime: tr ? tr.mime : '', seconds: tr ? tr.seconds : 0 };
    }).filter(Boolean);
    res.json({ ...collOut(c.toObject()), mine: String(c.owner) === String(req.user.id), items });
  } catch (e) {
    logger.error('[library/collection] error:', e);
    res.status(500).json({ error: 'Could not open that collection.' });
  }
});

router.post('/collections/:id/items', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const c = await openCollection(req, req.params.id);
    if (!c || (String(c.owner) !== String(req.user.id) && !isAdmin(req))) return res.status(404).json({ error: 'No such collection of yours.' });
    const b = req.body || {};
    const book = await openBook(req, b.book);
    if (!book) return res.status(404).json({ error: 'No such item.' });
    const track = clampInt(b.track, 0, 10000, 0);
    if (c.items.length >= 1000) return res.status(400).json({ error: 'A thousand items is the limit for one collection.' });
    c.items.push({ book: book._id, track, title: String(b.title || '').slice(0, 200) });
    await c.save();
    res.json({ ok: true, collection: collOut(c.toObject()) });
  } catch (e) {
    res.status(500).json({ error: 'Could not add that.' });
  }
});

router.post('/collections/:id/edit', requireJwtAuth, express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const c = await openCollection(req, req.params.id);
    if (!c || (String(c.owner) !== String(req.user.id) && !isAdmin(req))) return res.status(404).json({ error: 'No such collection of yours.' });
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) c.title = b.title.trim().slice(0, 200);
    if (typeof b.description === 'string') c.description = b.description.slice(0, 1000);
    if (typeof b.shared === 'boolean') c.shared = b.shared;
    if (Array.isArray(b.order)) { // new order as the current indexes
      const seen = new Set();
      const next = [];
      for (const n of b.order) { const i = parseInt(n, 10); if (Number.isInteger(i) && c.items[i] && !seen.has(i)) { seen.add(i); next.push(c.items[i]); } }
      if (next.length === c.items.length) c.items = next;
    }
    if (Number.isInteger(b.remove) && c.items[b.remove]) c.items.splice(b.remove, 1);
    await c.save();
    res.json({ ok: true, collection: collOut(c.toObject()) });
  } catch (e) {
    res.status(500).json({ error: 'Could not change that.' });
  }
});

router.delete('/collections/:id', requireJwtAuth, async (req, res) => {
  try {
    const c = await openCollection(req, req.params.id);
    if (!c || (String(c.owner) !== String(req.user.id) && !isAdmin(req))) return res.status(404).json({ error: 'No such collection of yours.' });
    await KadeCollection.deleteOne({ _id: c._id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete it.' });
  }
});

/* ── the library ───────────────────────────────────────────────────────── */
router.post('/book/:id/share', requireJwtAuth, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'No such book.' });
    const book = await KadeBook.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book.' });
    if (String(book.owner) !== String(req.user.id) && !isAdmin(req)) return res.status(403).json({ error: 'Only the person who donated a book can change where it sits.' });
    const b = req.body || {};
    if (b.shared === true && book.state !== 'ready') return res.status(400).json({ error: 'Add at least one recording before putting it in the library.' });
    /* Her rule: the private shelf needs nobody's approval; the PUBLIC library
     * needs the librarian's. Anyone but the librarian asking to share is
     * making a submission. */
    if (b.shared === true && !canPublish(req) && !book.shared) {
      const userName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
      const open = await KadeLibrarySubmission.findOne({ book: book._id, user: req.user.id, status: 'pending', type: 'submission' }).lean();
      if (!open) {
        await KadeLibrarySubmission.create({ user: req.user.id, userName, type: 'submission', book: book._id, title: book.title, note: String(b.note || '').slice(0, 2000) });
        refreshLibrarianDigest();
      }
      if (typeof b.grownUpsOnly === 'boolean') { book.grownUpsOnly = b.grownUpsOnly; await book.save(); }
      if (b.grownUpsOnly === true) await libraryFiles.propagateGrownUps([book._id]);
      return res.json({ ok: true, pending: true, book: summary(book.toObject(), null) });
    }
    if (typeof b.shared === 'boolean') {
      book.shared = b.shared;
      if (b.shared && !book.sharedAt) book.sharedAt = new Date();
      if (b.shared) book.sharedAt = new Date();
    }
    if (typeof b.grownUpsOnly === 'boolean') book.grownUpsOnly = b.grownUpsOnly;
    await book.save();
    if (b.grownUpsOnly === true) await libraryFiles.propagateGrownUps([book._id]);
    if (b.shared === true) await settleTrustedSubmissions(req, [book._id]);
    logger.info(`[reading-room/share] user=${req.user.id} "${book.title}" shared=${book.shared} grownUpsOnly=${book.grownUpsOnly}`);
    res.json({ ok: true, book: summary(book.toObject(), null) });
  } catch (e) {
    logger.error('[reading-room/share] error:', e);
    res.status(500).json({ error: 'Could not change that.' });
  }
});

/* A SHORTCUT (Sep 25 2026), Kade's words: "If there was some reason a file needed to be in multiple
 * collections, it can be a shortcut to the same file." Anyone who can open an item may put a
 * shortcut to it in a folder of their own: an ordinary row with its own title, folder, owner and
 * sharing that reads the item's file (no second copy is stored). It is never more open than the
 * file (grown-ups carries over), and it is shared only by someone who may publish. */
router.post('/book/:id/shortcut', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book || book.state !== 'ready') return res.status(404).json({ error: 'No such item.' });
    const fileId = book.fileId || book._id;
    const file = String(fileId) === String(book._id) ? book : await KadeBook.findById(fileId).lean();
    if (!file || file.state !== 'ready') return res.status(404).json({ error: 'No such item.' });
    // The file row learns its original's key first, so withdrawing this shortcut never counts it out.
    const fileKey = await ensureFileKey(file);
    const b = req.body || {};
    const path = cleanPath(b.path);
    if (!path) return res.status(400).json({ error: 'Say which folder the shortcut goes in.' });
    if (String(file.owner) === String(req.user.id) && libraryPath(file) === path) return res.status(409).json({ error: 'It is already in that folder.' });
    if (await KadeBook.exists({ owner: req.user.id, shortcutOf: fileId, path, state: 'ready' })) return res.status(409).json({ error: 'There is already a shortcut to it in that folder.' });
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const shared = canPublish(req) && (typeof b.shared === 'boolean' ? b.shared : !!file.shared);
    const row = await KadeBook.create({
      kind: file.kind, category: file.category || book.category, path, source: 'shortcut',
      title: String(b.title || '').trim().slice(0, 200) || book.title,
      author: book.author || '', publisher: book.publisher || '', copyrightYear: book.copyrightYear || '', synopsis: book.synopsis || '',
      description: book.description || '', language: file.language || 'en', isbn: book.isbn || '', bookshareId: book.bookshareId || '',
      meta: book.meta || {}, tags: book.tags || [], format: file.format || '', originalName: file.originalName || '',
      owner: req.user.id, ownerName,
      tracks: (file.tracks || []).map(({ _id, ...t }) => t),
      sections: file.sections || [], skipped: file.skipped || [], stats: file.stats || {}, jacket: file.jacket || '', parserVersion: file.parserVersion || 1,
      fileUrl: file.fileUrl || '', fileKey, fileBytes: file.fileBytes || 0, fileSha256: file.fileSha256 || '',
      shortcutOf: fileId, grownUpsOnly: !!(file.grownUpsOnly || b.grownUpsOnly === true),
      shared, ...(shared ? { sharedAt: new Date() } : {}), state: 'ready',
    });
    logger.info(`[library/shortcut] user=${req.user.id} "${row.title}" in ${path} -> ${fileId}`);
    res.json({ ok: true, item: summary(row.toObject(), null) });
  } catch (e) {
    logger.error('[library/shortcut] error:', e);
    res.status(500).json({ error: 'Could not make that shortcut.' });
  }
});

router.post('/book/:id/return', requireJwtAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'No such book.' });
    await KadeReadingProgress.deleteOne({ user: req.user.id, book: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not return that book.' });
  }
});

router.delete('/book/:id', requireJwtAuth, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ error: 'No such book.' });
    const book = await KadeBook.findById(req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book.' });
    if (String(book.owner) !== String(req.user.id) && !isAdmin(req)) return res.status(403).json({ error: 'Only the person who donated a book can withdraw it.' });
    /* The one-file rule (Sep 25 2026): if the owner's own shortcuts read this item's file, the oldest
     * takes it over (with the book text) before this row goes; shortcuts other people made to it go
     * with it (they simply lose the pointer); and a stored object is deleted only when no row left
     * lists it. A text book's original on B2 now goes with it too (it used to stay for good). */
    const row = book.toObject();
    const keys = [...(row.tracks || []).map((t) => t.key), row.fileKey || keyFromFileUrl(row.fileUrl)].filter(Boolean);
    const promoted = await libraryFiles.promoteShortcuts(row);
    const foreign = await libraryFiles.foreignShortcuts([row]);
    await Promise.all([
      promoted ? null : KadeBookText.deleteOne({ book: book._id }),
      KadeReadingProgress.deleteMany({ book: book._id }),
      KadeReadingBookmark.deleteMany({ book: book._id }),
      KadeBook.deleteOne({ _id: book._id }),
      ...(foreign.length ? [
        KadeBookText.deleteMany({ book: { $in: foreign } }),
        KadeReadingProgress.deleteMany({ book: { $in: foreign } }),
        KadeReadingBookmark.deleteMany({ book: { $in: foreign } }),
        KadeBook.deleteMany({ _id: { $in: foreign } }),
      ] : []),
    ]);
    libraryFiles.releaseKeys(keys, { except: [book._id, ...foreign] }).catch(() => {});
    logger.info(`[reading-room/delete] user=${req.user.id} withdrew "${book.title}" (${book._id})${foreign.length ? `; ${foreign.length} shortcut(s) other people made to it went with it` : ''}`);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[reading-room/delete] error:', e);
    res.status(500).json({ error: 'Could not withdraw that book.' });
  }
});

const { readingRoomHtml } = require('./kadeReadingRoomPage');
router.page = (_req, res) => res.type('html').send(readingRoomHtml);

module.exports = router;
module.exports._internals = { summary, chunkAt, openBook, refreshListen, libraryFiles };
