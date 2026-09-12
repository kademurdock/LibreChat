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
const multer = require('multer');
const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { saveBufferToS3 } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage } = require('~/models/kadeUsage');
const { KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, KadeCollection, CATEGORIES } = require('~/models/kadeBook');
const { parseBook } = require('./kadeReadingRoomParse');

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
const mimeFor = (name, hint) => {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (MEDIA_EXT[ext]) return { ext, mime: MEDIA_EXT[ext], kind: VIDEO_EXT[ext] ? 'video' : 'audio' };
  const h = String(hint || '');
  if (h.startsWith('video/')) return { ext: 'mp4', mime: h.slice(0, 60), kind: 'video' };
  if (h.startsWith('audio/')) return { ext: 'mp3', mime: h.slice(0, 60), kind: 'audio' };
  return null;
};
const MULTIPART_PART_BYTES = 100 * 1024 * 1024; // B2's S3 lane: 5 GB a single PUT; bigger files go in parts
const MULTIPART_ABOVE = 4 * 1024 * 1024 * 1024;
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
async function deleteKeys(keys) {
  const client = s3();
  if (!client || !keys.length) return;
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  for (const k of keys) {
    try { await client.send(new DeleteObjectCommand({ Bucket: MEDIA_BUCKET(), Key: k })); } catch (e) { logger.warn(`[reading-room] could not delete ${k}: ${e.message}`); }
  }
}
const trackKey = (bookId, ext) => `${MEDIA_PREFIX()}/${bookId}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

/** The App Store reviewer's seat, and any other account that must see an
 * EMPTY library: the shared shelf and every audio item are simply absent for
 * them. Comma-separated emails or user ids in KADE_LIBRARY_HIDDEN_FROM. */
function libraryHiddenFrom(req) {
  const list = String(process.env.KADE_LIBRARY_HIDDEN_FROM || 'kadeai.vischeck722@gmail.com').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const email = String((req.user && req.user.email) || '').toLowerCase();
  const id = String((req.user && req.user.id) || '').toLowerCase();
  return list.includes(email) || list.includes(id);
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

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024; // a scanned DAISY with images can run large
const PROXY_BASE = () => process.env.KADE_TTS_PROXY_URL || 'https://inworld-tts-proxy-production.up.railway.app';
const DEFAULT_VOICE = () => process.env.KADE_READING_DEFAULT_VOICE || process.env.KADE_DEFAULT_VOICE || 'Kiana (Comedian)';
/** A bracket direction the proxy lifts into Inworld's instruction field —
 * not billed as text, and the whole of the room's "steering". `KADE_READING_STEER=`
 * (empty) turns it off; a reader can pass ?steer=0 on a chunk. */
const STEER = () => (process.env.KADE_READING_STEER != null ? process.env.KADE_READING_STEER : '[reading a book aloud, steady audiobook pace]');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

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

/** Can this reader open this book? Owner, admin, or it is in the library and
 * not hidden from a child. Returns the book or null (404 either way). */
async function openBook(req, id) {
  if (!isId(id)) return null;
  const book = await KadeBook.findById(id).lean();
  if (!book) return null;
  const mine = String(book.owner) === String(req.user.id);
  if (book.state !== 'ready' && !mine) return null;
  if (mine || isAdmin(req)) return book;
  if (!book.shared || libraryHiddenFrom(req)) return null;
  if (book.grownUpsOnly && (await isChild(req))) return null;
  return book;
}

function summary(book, progress) {
  const total = (book.sections || []).length;
  const s = progress ? progress.s : 0;
  const tracks = book.kind !== 'text' ? (book.tracks || []).length : 0;
  const seconds = book.kind !== 'text' ? (book.tracks || []).reduce((n, t) => n + (t.seconds || 0), 0) : 0;
  return {
    id: String(book._id),
    kind: book.kind || 'text',
    category: book.category || 'book',
    description: book.description || '',
    tracks,
    seconds,
    state: book.state,
    path: book.path || '',
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
    const onShelf = new Set([...mineIds, ...borrowed.map((b) => String(b._id))]);
    res.json({
      librarian: isAdmin(req),
      me: String(userId),
      archiveOwned: await KadeBook.countDocuments({ owner: userId, path: { $ne: '' } }),
      mine: mine.map((b) => summary(b, progByBook[String(b._id)])),
      borrowed: borrowed.map((b) => summary(b, progByBook[String(b._id)])),
      library: library.filter((b) => !onShelf.has(String(b._id))).map((b) => summary(b, null)),
      categories: CATEGORIES,
      defaultVoice: DEFAULT_VOICE(),
    });
  } catch (e) {
    logger.error('[reading-room/shelf] error:', e);
    res.status(500).json({ error: 'Could not load the shelf.' });
  }
});

/* ── upload ────────────────────────────────────────────────────────────── */
const ACCEPT_EXT = ['zip', 'epub', 'txt', 'docx', 'html', 'htm', 'xhtml', 'xml'];
router.post('/upload', requireJwtAuth, (req, res, next) => {
  upload.single('book')(req, res, (err) => {
    if (err) {
      logger.warn(`[reading-room/upload] REFUSED user=${req.user.id}: ${err.code || err.message}`);
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 80 MB. Bookshare text-only DAISY zips are usually under 5 MB — try the text-only download.' : 'The file did not arrive. Try again.' });
    }
    next();
  });
}, async (req, res) => {
  const f = req.file;
  try {
    if (!f || !f.buffer || !f.buffer.length) return res.status(400).json({ error: 'No book arrived. Pick a file and try again.' });
    const ext = String(f.originalname || '').toLowerCase().split('.').pop();
    if (!ACCEPT_EXT.includes(ext) && !f.buffer.slice(0, 2).equals(Buffer.from('PK'))) {
      logger.warn(`[reading-room/upload] REFUSED user=${req.user.id} name=${String(f.originalname || '?').slice(0, 80)} mime=${f.mimetype || '(none)'}`);
      return res.status(400).json({ error: "I can't read that kind of file. Bookshare's DAISY zip, an EPUB, a text file, a Word file, or an HTML page all work." });
    }
    const t0 = Date.now();
    let parsed;
    try {
      parsed = await parseBook(f.buffer, f.originalname || 'book');
    } catch (e) {
      logger.warn(`[reading-room/upload] PARSE FAILED user=${req.user.id} name=${String(f.originalname || '?').slice(0, 80)} bytes=${f.buffer.length}: ${e.message}`);
      return res.status(400).json({ error: `I could not read that book. ${e.message}` });
    }
    if (!parsed.sections.length || parsed.stats.chars < 200) {
      return res.status(400).json({ error: 'That file has no readable text in it — a DAISY "audio only" zip has no words, the "text only" download does.' });
    }
    const grownUpsOnly = String((req.body || {}).grownUpsOnly || '') === '1' || (req.body || {}).grownUpsOnly === true;
    let fileUrl = '';
    try {
      if (typeof saveBufferToS3 === 'function') {
        const fileName = `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext || 'bin'}`;
        fileUrl = (await saveBufferToS3({ userId: String(req.user.id), buffer: f.buffer, fileName, basePath: 'books' })) || '';
      }
    } catch (e) {
      logger.warn(`[reading-room/upload] original not stored (${e.message}); the parsed text is enough to read`);
    }
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const book = await KadeBook.create({
      owner: req.user.id,
      ownerName,
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
      fileBytes: f.buffer.length,
      jacket: parsed.jacket,
      sections: parsed.sections.map((s) => ({ title: s.title, chunkCount: s.chunks.length, chars: s.chars, kind: s.kind })),
      skipped: parsed.skipped.map((s) => ({ title: s.title, reason: s.reason, chunkCount: s.chunks.length, chars: s.chars })),
      stats: { chunks: parsed.stats.chunks, chars: parsed.stats.chars, listen: parsed.stats.listen },
      grownUpsOnly,
      state: 'ready',
    });
    await KadeBookText.create({
      book: book._id,
      sections: parsed.sections.map((s) => ({ chunks: s.chunks })),
      skipped: parsed.skipped.map((s) => ({ chunks: s.chunks })),
    });
    logger.info(`[reading-room/upload] user=${req.user.id} "${book.title}" ${parsed.meta.format} ${f.buffer.length}B -> ${parsed.stats.sections} sections, ${parsed.stats.chunks} chunks, ${parsed.stats.chars} chars, skipped ${parsed.stats.skipped.join(',') || 'nothing'} in ${Date.now() - t0}ms`);
    res.json({ ok: true, book: summary(book.toObject(), null), skipped: book.skipped, jacket: book.jacket });
  } catch (e) {
    logger.error('[reading-room/upload] error:', e);
    res.status(500).json({ error: 'The book did not save. Try again in a moment.' });
  }
});

/* ── one book ──────────────────────────────────────────────────────────── */
router.get('/book/:id', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
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
        return { s: i, title: t.title || `Part ${i + 1}`, seconds: t.seconds || 0, bytes: t.bytes || 0, mime: t.mime, url,
          recaps: (t.recaps || []).map((r) => ({ from: r.from, to: r.to, summary: r.summary, scenes: r.scenes || [], at: r.at })),
          description: d.state ? { state: d.state, summary: d.summary || '', scenes: d.scenes || [], model: d.model || '', costUSD: d.costUSD || 0, error: d.error || '', at: d.at } : null };
      }));
    }
    res.json({
      ...summary(book, progress),
      tracks,
      librarian: book.librarian && book.librarian.state ? book.librarian : null,
      jacket: book.jacket,
      chapters: (book.sections || []).map((s, i) => ({ s: i, title: s.title, chunks: s.chunkCount, chars: s.chars, kind: s.kind })),
      skipped: (book.skipped || []).map((s, i) => ({ k: i, title: s.title, reason: s.reason, chunks: s.chunkCount, chars: s.chars })),
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
  const text = await KadeBookText.findOne({ book: book._id }, skipped ? { skipped: { $slice: [s, 1] } } : { sections: { $slice: [s, 1] } }).lean();
  const list = skipped ? (text && text.skipped) || [] : (text && text.sections) || [];
  const sec = list[0];
  if (!sec || !sec.chunks || c >= sec.chunks.length) return null;
  const meta = skipped ? (book.skipped || [])[s] : (book.sections || [])[s];
  const counts = skipped ? (book.skipped || []).map((x) => x.chunkCount) : (book.sections || []).map((x) => x.chunkCount);
  const next = c + 1 < sec.chunks.length ? { s, c: c + 1 } : s + 1 < counts.length ? { s: s + 1, c: 0 } : null;
  const prev = c > 0 ? { s, c: c - 1 } : s > 0 ? { s: s - 1, c: Math.max(0, (counts[s - 1] || 1) - 1) } : null;
  return { text: sec.chunks[c], title: meta ? meta.title : '', s, c, count: sec.chunks.length, next, prev };
}

router.get('/book/:id/text/:s/:c', requireJwtAuth, async (req, res) => {
  try {
    const book = await openBook(req, req.params.id);
    if (!book) return res.status(404).json({ error: 'No such book on your shelf.' });
    const skipped = req.query.skipped === '1';
    const s = clampInt(req.params.s, 0, 100000, 0);
    const c = clampInt(req.params.c, 0, 100000, 0);
    const chunk = await chunkAt(book, s, c, skipped);
    if (!chunk) return res.status(404).json({ error: 'Past the end of the book.' });
    res.json(chunk);
  } catch (e) {
    logger.error('[reading-room/text] error:', e);
    res.status(500).json({ error: 'Could not read that part.' });
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
    const chunk = await chunkAt(book, s, c, skipped);
    if (!chunk) return res.status(404).json({ error: 'Past the end of the book.' });
    const voice = String(req.query.voice || DEFAULT_VOICE()).slice(0, 120);
    const speed = Math.max(0.5, Math.min(1.5, parseFloat(req.query.speed) || 1));
    const steer = req.query.steer === '0' ? '' : STEER();
    const input = (steer ? steer + ' ' : '') + chunk.text;
    const headers = {
      'Content-Type': 'application/json',
      'x-kade-tts-session': `reading:${String(req.user.id).slice(0, 24)}:${String(book._id).slice(-12)}`,
      'x-kade-tts-stream': '1',
    };
    const upstream = await axios.post(
      `${PROXY_BASE()}/v1/audio/speech`,
      { input, voice, model: 'tts-1', speed, delivery: 'STABLE', stream: '1' },
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
    const set = { s, c, pos: audio ? Math.max(0, parseFloat(b.pos) || 0) : 0 };
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
      snippet: chunk.text.slice(0, 120),
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
    const category = CATEGORIES.includes(String(b.category)) && b.category !== 'book' ? String(b.category) : 'audiobook';
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const item = await KadeBook.create({
      kind: 'audio',
      category,
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

/** Step 1 of a direct upload: a signed PUT the client sends the bytes to. */
router.post('/media/:id/track/presign', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const b = req.body || {};
    const m = mimeFor(b.fileName, b.mime);
    if (!m) return res.status(400).json({ error: 'That is not an audio or video file. MP3, M4A, M4B, AAC, WAV, OGG, FLAC, MP4, M4V, MOV or WebM all work.' });
    const bytes = Math.max(0, parseInt(b.bytes, 10) || 0);
    if (bytes > MAX_TRACK_BYTES) return res.status(400).json({ error: 'One file is over 20 GB — split it into parts.' });
    if ((item.tracks || []).length >= 200) return res.status(400).json({ error: 'Two hundred parts is the limit for one item.' });
    const key = trackKey(item._id, m.ext);
    const url = await signPut(key, m.mime, bytes);
    res.json({ ok: true, key, url, mime: m.mime, method: 'PUT', headers: { 'Content-Type': m.mime }, expiresInSeconds: 3 * 3600 });
  } catch (e) {
    logger.error('[reading-room/media/presign] error:', e.message);
    res.status(500).json({ error: 'Could not prepare the upload. ' + (/(not configured)/.test(e.message) ? 'Media storage is not set up.' : 'Try again.') });
  }
});

/** Step 2: the client says the bytes landed; we check the object exists. */
router.post('/media/:id/track/done', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const b = req.body || {};
    const key = String(b.key || '');
    if (!key.startsWith(`${MEDIA_PREFIX()}/${item._id}/`)) return res.status(400).json({ error: 'That upload does not belong to this item.' });
    if ((item.tracks || []).some((t) => t.key === key)) return res.json({ ok: true, item: summary(item.toObject(), null) });
    let head;
    try { head = await headObject(key); } catch (e) { return res.status(400).json({ error: 'The file did not arrive in storage. Try the upload again.' }); }
    const ext = key.split('.').pop();
    item.tracks.push({
      title: String(b.title || '').trim().slice(0, 200) || `Part ${item.tracks.length + 1}`,
      key,
      bytes: Number(head.ContentLength) || Math.max(0, parseInt(b.bytes, 10) || 0),
      seconds: Math.max(0, parseFloat(b.seconds) || 0),
      mime: MEDIA_EXT[ext] || head.ContentType || 'audio/mpeg',
      originalName: String(b.originalName || '').slice(0, 200),
    });
    if (VIDEO_EXT[ext] && item.kind !== 'video') item.kind = 'video';
    item.state = 'ready';
    refreshListen(item);
    await item.save();
    logger.info(`[reading-room/media] user=${req.user.id} "${item.title}" +track ${key} ${head.ContentLength || '?'}B (${item.tracks.length} total)`);
    res.json({ ok: true, item: summary(item.toObject(), null) });
  } catch (e) {
    logger.error('[reading-room/media/done] error:', e);
    res.status(500).json({ error: 'Could not record that upload.' });
  }
});

/** The through-the-server lane (<= 80 MB): for browsers until the bucket has
 * a CORS rule, and for anything small. Same result as presign + done. */
router.post('/media/:id/track/upload', requireJwtAuth, (req, res, next) => {
  upload.single('track')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Over 80 MB — the phone app sends big recordings straight to storage; on the web, split it into parts.' : 'The file did not arrive.' });
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
    const key = trackKey(item._id, m.ext);
    await putBuffer(key, f.buffer, mime);
    item.tracks.push({
      title: String((req.body || {}).title || '').trim().slice(0, 200) || `Part ${item.tracks.length + 1}`,
      key, bytes: f.buffer.length, seconds: Math.max(0, parseFloat((req.body || {}).seconds) || 0), mime,
      originalName: String(f.originalname || '').slice(0, 200),
    });
    if (m.kind === 'video') item.kind = 'video';
    item.state = 'ready';
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
    const [gone] = item.tracks.splice(t, 1);
    if (!item.tracks.length) { item.state = 'pending'; item.shared = false; }
    refreshListen(item);
    await item.save();
    deleteKeys([gone.key]).catch(() => {});
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
    const shared = b.private === true ? false : true;
    const ownerName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const out = [];
    for (const f of files) {
      const originalPath = cleanPath(f.originalPath || (f.path && f.name ? `${f.path}/${f.name}` : f.name));
      const m = mimeFor(f.name, f.mime);
      if (!m) { out.push({ originalPath, error: 'not a playable audio or video file' }); continue; }
      const bytes = Math.max(0, parseInt(f.bytes, 10) || 0);
      if (bytes > MAX_TRACK_BYTES) { out.push({ originalPath, error: 'over 20 GB' }); continue; }
      const existing = await KadeBook.findOne({ owner: req.user.id, originalPath }).lean();
      if (existing && existing.state === 'ready') { out.push({ originalPath, id: String(existing._id), skipped: 'already in the library' }); continue; }
      const folder = cleanPath(f.path || '');
      const top = folder.split('/')[1] || folder.split('/')[0] || '';
      const title = String(f.title || f.name || 'Untitled').replace(/\.[^.]+$/, '').slice(0, 200);
      const meta = f.meta && typeof f.meta === 'object' ? Object.fromEntries(Object.entries(f.meta).slice(0, 20).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 120)])) : {};
      const doc = existing || new KadeBook({ owner: req.user.id, ownerName });
      doc.kind = m.kind;
      doc.category = CATEGORIES.includes(String(f.category)) ? String(f.category) : ARCHIVE_CATEGORY(top);
      doc.title = title;
      doc.author = String(meta.network || meta.cableChannel || meta.callSign || meta.brand || '').slice(0, 200);
      doc.copyrightYear = String(meta.year || '').slice(0, 12);
      doc.description = String(f.description || '').slice(0, 2000);
      doc.path = folder;
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
    logger.error('[library/archive/presign] error:', e.message);
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
        item.tracks = [{ title: item.title, key, bytes: Number(head.ContentLength) || 0, seconds: Math.max(0, parseFloat(f.seconds) || 0), mime: MEDIA_EXT[ext] || head.ContentType || 'video/mp4', originalName: String(f.originalName || '').slice(0, 200) }];
        if (VIDEO_EXT[ext]) item.kind = 'video';
        item.state = 'ready';
        refreshListen(item);
        await item.save();
        out.push({ id: String(item._id), ok: true, bytes: item.tracks[0].bytes });
      } catch (e) {
        out.push({ id: String(item._id), error: 'the file is not in storage: ' + e.message });
      }
    }
    res.json({ ok: true, files: out });
  } catch (e) {
    logger.error('[library/archive/done] error:', e.message);
    res.status(500).json({ error: 'Could not record those uploads.' });
  }
});

/** Browse the archive like a drive: folders under `path`, items at `path`. */
router.get('/archive', requireJwtAuth, async (req, res) => {
  try {
    const hidden = libraryHiddenFrom(req); // the reviewer seat sees only its own uploads
    const child = await isChild(req);
    const at = cleanPath(req.query.path || '');
    const page = clampInt(req.query.page, 0, 100000, 0);
    const limit = clampInt(req.query.limit, 1, 200, 60);
    // the aggregate below does not cast strings to ObjectId the way find() does
    const ownerId = new mongoose.Types.ObjectId(String(req.user.id));
    const base = { state: 'ready', path: { $ne: '' }, $or: hidden ? [{ owner: ownerId }] : [{ shared: true }, { owner: ownerId }], ...(child ? { grownUpsOnly: { $ne: true } } : {}) };
    const prefix = at ? at + '/' : '';
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [folders, items, total] = await Promise.all([
      KadeBook.aggregate([
        { $match: { ...base, path: { $regex: '^' + escaped + '.+' } } },
        { $project: { seg: { $arrayElemAt: [{ $split: [{ $substrCP: ['$path', prefix.length, 400] }, '/'] }, 0] } } },
        { $group: { _id: '$seg', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
        { $limit: 500 },
      ]),
      KadeBook.find({ ...base, path: at }).sort({ title: 1 }).skip(page * limit).limit(limit).lean(),
      KadeBook.countDocuments({ ...base, path: at }),
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
    const base = { state: 'ready', $or: hidden ? [{ owner: req.user.id }] : [{ shared: true }, { owner: req.user.id }], ...(child ? { grownUpsOnly: { $ne: true } } : {}) };
    const words = q.split(/\s+/).filter(Boolean).map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const items = await KadeBook.find({ ...base, $and: words.map((re) => ({ $or: [{ title: re }, { author: re }, { path: re }, { tags: re }] })) }).sort({ title: 1 }).limit(100).lean();
    res.json({ items: items.map((b) => summary(b, null)), q });
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
    res.json({ ok: true, enabled: describer.ENABLED(), ...est, hasSeconds: !!tr.seconds, queued: describer.queued(), progress: describer.progressOf(String(book._id), t), state: (tr.description || {}).state || '' });
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
    if (d.state === 'working') return res.json({ ok: true, state: 'working', progress: describer.progressOf(String(book._id), t) });
    const signedUrl = await signGet(tr.key, tr.mime);
    await KadeBook.updateOne({ _id: book._id }, { $set: { [`tracks.${t}.description.state`]: 'working', [`tracks.${t}.description.error`]: '' } });
    const bookId = String(book._id);
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
    res.json({ ok: true, state: d.state || '', progress: describer.progressOf(String(book._id), t), description: d.state ? d : null });
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
    const bookId = String(book._id);
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
    res.json({ ok: true, state: hit ? 'done' : (describer.progressOf(String(book._id), t) ? 'working' : ''), progress: describer.progressOf(String(book._id), t), recap: hit || null });
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
    notifyLibrarians(`${userName} says "${book.title}" is on the wrong shelf${suggestedPath ? ` — suggests ${suggestedPath}` : ''}${suggestedCategory ? ` (${suggestedCategory})` : ''}. Open the Library page to move it or leave it.`);
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
async function notifyLibrarians(text) {
  try {
    const { User } = require('~/db/models');
    const admins = await User.find({ role: 'ADMIN' }, '_id name').lean();
    for (const a of admins) await notifyUser(a._id, text, a.name);
  } catch (e) {
    logger.warn(`[library/submissions] admin notify failed: ${e.message}`);
  }
}

router.post('/submissions', requireJwtAuth, express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const url = String(b.url || '').trim().slice(0, 2000);
    const title = String(b.title || '').trim().slice(0, 300);
    const note = String(b.note || '').trim().slice(0, 2000);
    let book = null;
    if (b.book && isId(b.book)) {
      const item = await KadeBook.findOne({ _id: b.book, owner: req.user.id }).lean();
      if (item) book = item._id;
    }
    if (!url && !book) return res.status(400).json({ error: 'Give a link, or donate a file first and submit that.' });
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'That does not look like a link. It should start with http.' });
    const open = await KadeLibrarySubmission.countDocuments({ user: req.user.id, status: 'pending' });
    if (open >= 50) return res.status(400).json({ error: 'You have fifty submissions waiting already — give the librarian a minute.' });
    const userName = String(req.user.name || req.user.username || req.user.email || '').split('@')[0].split(' ')[0] || 'someone';
    const s = await KadeLibrarySubmission.create({ user: req.user.id, userName, url, title, note, book });
    logger.info(`[library/submissions] ${userName} submitted ${url || 'file ' + book} "${title}"`);
    notifyLibrarians(`${userName} submitted something for the family library${title ? `: "${title}"` : ''}${url ? ` (${url})` : ' (a file)'}. Open the Library page to approve or decline it.`);
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
    if (typeof b.shared === 'boolean') { if (b.shared && item.state !== 'ready') return res.status(400).json({ error: 'Add a recording before sharing it.' }); item.shared = b.shared; if (b.shared) item.sharedAt = new Date(); changed.push(b.shared ? 'shared' : 'private'); }
    if (typeof b.grownUpsOnly === 'boolean') { item.grownUpsOnly = b.grownUpsOnly; changed.push('grown-ups'); }
    if (Array.isArray(b.tags)) { item.tags = b.tags.slice(0, 30).map((t) => String(t).slice(0, 60)); changed.push('tags'); }
    if (Array.isArray(b.trackTitles) && item.tracks) b.trackTitles.forEach((t, i) => { if (item.tracks[i] && typeof t === 'string' && t.trim()) item.tracks[i].title = t.trim().slice(0, 200); });
    await item.save();
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
    const q = { path: { $regex: '^' + escaped + '(/|$)' }, ...(isAdmin(req) ? {} : { owner: req.user.id }) };
    const items = await KadeBook.find(q, '_id path').lean();
    if (!items.length) return res.status(404).json({ error: 'No items of yours in that folder.' });
    const ops = items.map((it) => ({ updateOne: { filter: { _id: it._id }, update: { $set: { path: to + it.path.slice(from.length) } } } }));
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
    else if (action === 'share') r = await KadeBook.updateMany({ ...q, state: 'ready' }, { $set: { shared: true, sharedAt: new Date() } });
    else if (action === 'unshare') r = await KadeBook.updateMany(q, { $set: { shared: false } });
    else if (action === 'grownups') r = await KadeBook.updateMany(q, { $set: { grownUpsOnly: b.value !== false } });
    else if (action === 'category' && CATEGORIES.includes(String(b.value))) r = await KadeBook.updateMany({ ...q, kind: { $ne: 'text' } }, { $set: { category: String(b.value) } });
    else if (action === 'delete') {
      const items = await KadeBook.find(q).lean();
      const keys = items.flatMap((it) => (it.tracks || []).map((t) => t.key)).filter(Boolean);
      const del = items.map((it) => it._id);
      await Promise.all([KadeBookText.deleteMany({ book: { $in: del } }), KadeReadingProgress.deleteMany({ book: { $in: del } }), KadeReadingBookmark.deleteMany({ book: { $in: del } }), KadeBook.deleteMany({ _id: { $in: del } })]);
      deleteKeys(keys).catch(() => {});
      r = { modifiedCount: del.length };
    } else return res.status(400).json({ error: 'Unknown action.' });
    logger.info(`[library/batch] user=${req.user.id} ${action} ${r.modifiedCount || 0}/${ids.length}`);
    res.json({ ok: true, changed: r.modifiedCount || 0 });
  } catch (e) {
    logger.error('[library/batch] error:', e);
    res.status(500).json({ error: 'Could not do that.' });
  }
});

/* ── THE LIBRARIAN SORTS THE BOOKS ─────────────────────────────────────── */
const sorter = require('./kadeReadingRoomSort');
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
    const books = ids.length ? await KadeBook.find({ _id: { $in: ids }, state: 'ready', ...(child ? { grownUpsOnly: { $ne: true } } : {}) }).lean() : [];
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
    if (typeof b.shared === 'boolean') {
      book.shared = b.shared;
      if (b.shared && !book.sharedAt) book.sharedAt = new Date();
      if (b.shared) book.sharedAt = new Date();
    }
    if (typeof b.grownUpsOnly === 'boolean') book.grownUpsOnly = b.grownUpsOnly;
    await book.save();
    logger.info(`[reading-room/share] user=${req.user.id} "${book.title}" shared=${book.shared} grownUpsOnly=${book.grownUpsOnly}`);
    res.json({ ok: true, book: summary(book.toObject(), null) });
  } catch (e) {
    logger.error('[reading-room/share] error:', e);
    res.status(500).json({ error: 'Could not change that.' });
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
    if (isMedia(book)) deleteKeys((book.tracks || []).map((t) => t.key).filter(Boolean)).catch(() => {});
    await Promise.all([
      KadeBookText.deleteOne({ book: book._id }),
      KadeReadingProgress.deleteMany({ book: book._id }),
      KadeReadingBookmark.deleteMany({ book: book._id }),
      KadeBook.deleteOne({ _id: book._id }),
    ]);
    logger.info(`[reading-room/delete] user=${req.user.id} withdrew "${book.title}" (${book._id})`);
    res.json({ ok: true });
  } catch (e) {
    logger.error('[reading-room/delete] error:', e);
    res.status(500).json({ error: 'Could not withdraw that book.' });
  }
});

const { readingRoomHtml } = require('./kadeReadingRoomPage');
router.page = (_req, res) => res.type('html').send(readingRoomHtml);

module.exports = router;
module.exports._internals = { summary, chunkAt, openBook };
