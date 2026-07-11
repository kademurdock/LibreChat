/**
 * SHARE-TO-DESCRIBE routes (July 11 2026). Page: GET /describe (mounted in
 * server/index.js). API under /api/kade/describe/*:
 *
 *   POST /share     — Web Share Target receiver (Android/installed PWAs POST
 *                     multipart here straight from the OS share sheet; no auth,
 *                     bounded store, 303 → /describe?id=...)
 *   POST /upload    — the page's own picker (JWT)
 *   POST /ingest    — iPhone-Shortcut path (x-kade-token personal token; iOS
 *                     Safari still has no Web Share Target — WebKit bug 194593)
 *   GET  /token     — mint the personal token + ready-to-paste ingest URL (JWT)
 *   POST /run       — run the describe pipeline on a pending item (JWT, or the
 *                     item is already token-bound to a user). The ONLY step
 *                     that costs anything; result cached on the item.
 *   POST /reminder  — save a detected date as a real reminder memory card
 *                     (rides the July 11 nudge engine).
 */
const express = require('express');
const multer = require('multer');
const { Tokenizer } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { createMemory, setMemory } = require('~/models');
const { logKadeUsage } = require('~/models/kadeUsage');
const { parseCentralDateTime } = require('~/server/services/kadeNudges');
const {
  putShareItem,
  getShareItem,
  mintShareToken,
  verifyShareToken,
  runDescribe,
  PENDING_RESULT_TTL_MS,
  MAX_MEDIA_BYTES,
} = require('~/server/services/kadeDescribe');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_BYTES, files: 6, fields: 12 },
});

function firstFile(req) {
  if (req.file) {
    return req.file;
  }
  const files = Array.isArray(req.files) ? req.files : [];
  return files[0] || null;
}

/** Web Share Target receiver — the OS navigates here with a multipart POST. */
router.post('/share', upload.any(), (req, res) => {
  try {
    const f = firstFile(req);
    const title = String((req.body || {}).title || '').slice(0, 300) || null;
    const text = String((req.body || {}).text || '').slice(0, 60000) || null;
    const url = String((req.body || {}).url || '').slice(0, 2000) || null;
    if (!f && !text && !title && !url) {
      return res.redirect(303, '/describe?err=empty');
    }
    const id = putShareItem({
      buf: f ? f.buffer : null,
      mime: f ? f.mimetype : null,
      name: f ? f.originalname : null,
      title,
      text: text || (url ? `Shared link: ${url}` : null),
      userId: null,
    });
    const extra = Array.isArray(req.files) && req.files.length > 1 ? '&more=1' : '';
    return res.redirect(303, `/describe?id=${id}${extra}`);
  } catch (err) {
    logger.error('[kadeDescribe] /share failed:', err);
    return res.redirect(303, '/describe?err=share');
  }
});

/** In-page picker upload (signed-in). */
router.post('/upload', requireJwtAuth, upload.any(), (req, res) => {
  const f = firstFile(req);
  if (!f) {
    return res.status(400).json({ error: 'No file received' });
  }
  const id = putShareItem({
    buf: f.buffer,
    mime: f.mimetype,
    name: f.originalname,
    title: null,
    text: null,
    userId: String(req.user.id || req.user._id),
  });
  return res.json({ ok: true, id });
});

/** iPhone Shortcut ingest — personal token in header or query. */
router.post('/ingest', upload.any(), (req, res) => {
  const token =
    req.headers['x-kade-token'] || (req.query || {}).token || (req.body || {}).token || '';
  const userId = verifyShareToken(String(token));
  if (!userId) {
    return res.status(403).json({
      error: 'Bad or missing share token. Open kademurdock.com/describe while signed in to get yours.',
    });
  }
  const f = firstFile(req);
  const text = String((req.body || {}).text || '').slice(0, 60000) || null;
  if (!f && !text) {
    return res.status(400).json({ error: 'No file or text received' });
  }
  const id = putShareItem({
    buf: f ? f.buffer : null,
    mime: f ? f.mimetype : null,
    name: f ? f.originalname : null,
    title: null,
    text,
    userId,
  });
  const base = process.env.DOMAIN_SERVER || 'https://kademurdock.com';
  return res.json({ ok: true, id, url: `${base.replace(/\/$/, '')}/describe?id=${id}` });
});

/** Personal token for the Shortcut setup box. */
router.get('/token', requireJwtAuth, (req, res) => {
  const token = mintShareToken(String(req.user.id || req.user._id));
  if (!token) {
    return res.status(503).json({ error: 'Share tokens are not configured on the server.' });
  }
  const base = (process.env.DOMAIN_SERVER || 'https://kademurdock.com').replace(/\/$/, '');
  return res.json({ token, ingestUrl: `${base}/api/kade/describe/ingest?token=${encodeURIComponent(token)}` });
});

/** Resolve who may act on an item: a signed-in user, or the upload's bound user. */
function actingUser(req, item) {
  if (req.user && (req.user.id || req.user._id)) {
    return String(req.user.id || req.user._id);
  }
  return item && item.userId ? String(item.userId) : null;
}

/** Optional-JWT shim: attach req.user when a valid Bearer token is present,
 * but NEVER fail the request (requireJwtAuth self-sends 401s, so it can't be
 * reused here — the Shortcut/Safari path legitimately has no session). */
const passport = require('passport');
function optionalJwt(req, res, next) {
  if (!req.headers.authorization) {
    return next();
  }
  passport.authenticate('jwt', { session: false }, (err, user) => {
    if (!err && user) {
      req.user = user;
    }
    next();
  })(req, res, next);
}

router.post('/run', optionalJwt, express.json(), async (req, res) => {
  try {
    const item = getShareItem((req.body || {}).id);
    if (!item) {
      return res.status(404).json({
        error: 'That share has expired (they only keep for about 10 minutes). Share it again.',
      });
    }
    const userId = actingUser(req, item);
    if (!userId) {
      return res.status(401).json({ error: 'sign-in-required' });
    }
    if (item.result) {
      return res.json({ ok: true, ...item.result });
    }
    if (!item.running) {
      item.running = runDescribe(item)
        .then((result) => {
          item.result = result;
          item.exp = Date.now() + PENDING_RESULT_TTL_MS;
          item.buf = null; // media no longer needed once described
          logKadeUsage({
            userId,
            service: 'describe',
            quantity: 1,
            unit: 'items',
            costUSD: result.costUSD,
            metadata: { kind: result.kind, name: result.name || undefined, model: result.model },
          }).catch(() => {});
          return result;
        })
        .finally(() => {
          item.running = null;
        });
    }
    const result = await item.running;
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error('[kadeDescribe] /run failed: ' + err.message);
    return res.status(500).json({ error: err.message || 'Describe failed' });
  }
});

router.post('/reminder', optionalJwt, express.json(), async (req, res) => {
  try {
    const { id, when, label } = req.body || {};
    const item = id ? getShareItem(id) : null;
    const userId = actingUser(req, item);
    if (!userId) {
      return res.status(401).json({ error: 'Sign in to save reminders.' });
    }
    const dueAt = parseCentralDateTime(String(when || ''));
    if (!dueAt) {
      return res.status(400).json({ error: 'Bad date — expected YYYY-MM-DD HH:mm (Central).' });
    }
    const cleanLabel = String(label || 'Appointment from a shared document').trim().slice(0, 160);
    const value = `${cleanLabel} — ${String(when).trim()} (saved from a shared document on /describe)`;
    // MemoryEntry keys allow ONLY lowercase letters + underscores (no digits).
    const slug = cleanLabel.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
    const key = ('reminder_' + (slug || 'from_document')).replace(/_+$/g, '');
    const tokenCount = Tokenizer.getTokenCount(value, 'o200k_base');
    try {
      await createMemory({ userId, key, value, tokenCount, type: 'reminder', dueAt });
    } catch (err) {
      if (/already exists/i.test(String(err.message))) {
        await setMemory({ userId, key, value, tokenCount, type: 'reminder', dueAt });
      } else {
        throw err;
      }
    }
    return res.json({ ok: true, key, when: String(when).trim(), label: cleanLabel });
  } catch (err) {
    logger.error('[kadeDescribe] /reminder failed: ' + err.message);
    return res.status(500).json({ error: 'Could not save the reminder.' });
  }
});

const { describeHtml } = require('./kadePages');
router.page = (req, res) => res.type('html').send(describeHtml);

module.exports = router;
