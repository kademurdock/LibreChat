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
const { KadeBook, KadeBookText, KadeReadingProgress, KadeReadingBookmark, CATEGORIES } = require('~/models/kadeBook');
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
const MAX_TRACK_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB a track
const AUDIO_EXT = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', mp4: 'audio/mp4', aiff: 'audio/aiff', aif: 'audio/aiff', wma: 'audio/x-ms-wma' };
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
  const tracks = book.kind === 'audio' ? (book.tracks || []).length : 0;
  const seconds = book.kind === 'audio' ? (book.tracks || []).reduce((n, t) => n + (t.seconds || 0), 0) : 0;
  return {
    id: String(book._id),
    kind: book.kind || 'text',
    category: book.category || 'book',
    description: book.description || '',
    tracks,
    seconds,
    state: book.state,
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
          where: book.kind === 'audio' ? (tracks ? `${Math.min(s + 1, tracks)} of ${tracks}` : '') : total ? `${Math.min(s + 1, total)} of ${total}` : '' }
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
      KadeBook.find({ owner: userId, state: { $in: ['ready', 'pending'] } }).sort({ updatedAt: -1 }).lean(),
      KadeReadingProgress.find({ user: userId }).sort({ updatedAt: -1 }).lean(),
      hidden ? [] : KadeBook.find({ shared: true, state: 'ready', ...(child ? { grownUpsOnly: { $ne: true } } : {}) }).sort({ sharedAt: -1 }).limit(500).lean(),
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
    const [progress, bookmarks] = await Promise.all([
      KadeReadingProgress.findOne({ user: req.user.id, book: book._id }).lean(),
      KadeReadingBookmark.find({ user: req.user.id, book: book._id }).sort({ createdAt: -1 }).lean(),
    ]);
    let tracks = [];
    if (book.kind === 'audio') {
      tracks = await Promise.all((book.tracks || []).map(async (t, i) => {
        let url = '';
        try { url = await signGet(t.key, t.mime); } catch (e) { logger.warn(`[reading-room/book] sign failed for ${t.key}: ${e.message}`); }
        return { s: i, title: t.title || `Part ${i + 1}`, seconds: t.seconds || 0, bytes: t.bytes || 0, mime: t.mime, url };
      }));
    }
    res.json({
      ...summary(book, progress),
      tracks,
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
    const audio = book.kind === 'audio';
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
    if (book.kind === 'audio') {
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
  if (!item || item.kind !== 'audio') return null;
  if (String(item.owner) !== String(req.user.id) && !isAdmin(req)) return null;
  return item;
}

/** Step 1 of a direct upload: a signed PUT the client sends the bytes to. */
router.post('/media/:id/track/presign', requireJwtAuth, express.json({ limit: '4kb' }), async (req, res) => {
  try {
    const item = await ownAudio(req, req.params.id);
    if (!item) return res.status(404).json({ error: 'No such donation.' });
    const b = req.body || {};
    const ext = String(b.fileName || '').toLowerCase().split('.').pop();
    const mime = AUDIO_EXT[ext] || (String(b.mime || '').startsWith('audio/') ? String(b.mime).slice(0, 60) : null);
    if (!mime) return res.status(400).json({ error: 'That is not an audio file. MP3, M4A, M4B, AAC, WAV, OGG or FLAC all work.' });
    const bytes = Math.max(0, parseInt(b.bytes, 10) || 0);
    if (bytes > MAX_TRACK_BYTES) return res.status(400).json({ error: 'One recording is over 2 GB — split it into parts.' });
    if ((item.tracks || []).length >= 200) return res.status(400).json({ error: 'Two hundred parts is the limit for one item.' });
    const key = trackKey(item._id, AUDIO_EXT[ext] ? ext : 'mp3');
    const url = await signPut(key, mime, bytes);
    res.json({ ok: true, key, url, mime, method: 'PUT', headers: { 'Content-Type': mime }, expiresInSeconds: 3 * 3600 });
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
      mime: AUDIO_EXT[ext] || head.ContentType || 'audio/mpeg',
      originalName: String(b.originalName || '').slice(0, 200),
    });
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
    const ext = String(f.originalname || '').toLowerCase().split('.').pop();
    const mime = AUDIO_EXT[ext] || (String(f.mimetype || '').startsWith('audio/') ? f.mimetype : null);
    if (!mime) return res.status(400).json({ error: 'That is not an audio file. MP3, M4A, M4B, AAC, WAV, OGG or FLAC all work.' });
    const key = trackKey(item._id, AUDIO_EXT[ext] ? ext : 'mp3');
    await putBuffer(key, f.buffer, mime);
    item.tracks.push({
      title: String((req.body || {}).title || '').trim().slice(0, 200) || `Part ${item.tracks.length + 1}`,
      key, bytes: f.buffer.length, seconds: Math.max(0, parseFloat((req.body || {}).seconds) || 0), mime,
      originalName: String(f.originalname || '').slice(0, 200),
    });
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
    if (book.kind === 'audio') deleteKeys((book.tracks || []).map((t) => t.key).filter(Boolean)).catch(() => {});
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
