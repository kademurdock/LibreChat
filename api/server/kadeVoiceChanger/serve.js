'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * The Voice Changer engine on the web (Oct 22 2026, CONTRACT.md section 10).
 *
 * The engine folder is served read-only at /vc-engine/<version>/, where the
 * version is manifest.json's, read once at startup. Every relative import in
 * the engine then resolves inside one version, so no ?v= is needed anywhere:
 *   - the current version is cached for a year and marked immutable;
 *   - any other version still answers (with today's files) but says no-cache,
 *     so a page left open across a deploy never pins an old engine for a year;
 *   - tools/ and test/ never leave the server (404), dot files are refused,
 *     folders never list, and nothing redirects.
 * CORS is open (the engine is public code and the iPhone's hidden page imports
 * it), and the content types are set here rather than guessed, because a
 * module Worker refuses a script served as anything but JavaScript.
 * ───────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const express = require('express');

const ENGINE_DIR = path.join(__dirname, 'engine');
const IMMUTABLE = 'public, max-age=31536000, immutable';
const PRIVATE_FOLDERS = new Set(['tools', 'test']);
const TYPES = {
  '.js': 'application/javascript; charset=UTF-8',
  '.mjs': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.wav': 'audio/wav',
};

const cache = new Map();

/** The version in the engine's manifest.json, read once per folder. */
function engineVersion(dir = ENGINE_DIR) {
  if (!cache.has(dir)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const version = String((manifest && manifest.version) || '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
      throw new Error('The Voice Changer engine manifest has no usable version.');
    }
    cache.set(dir, version);
  }
  return cache.get(dir);
}

/** True when a request path (still percent-encoded) reaches somewhere the engine must not show. */
function isPrivatePath(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawPath || ''));
  } catch (_) {
    return true;
  }
  const parts = decoded.split(/[\\/]+/).filter((p) => p && p !== '.');
  return parts.some((p) => p === '..' || p.includes('\0') || PRIVATE_FOLDERS.has(p.toLowerCase()));
}

function notFound(res, status = 404) {
  res.removeHeader('Cache-Control');
  res.removeHeader('Content-Type');
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');
  res
    .status(status)
    .set('Cache-Control', 'no-store')
    .type('text/plain')
    .send(status === 404 ? 'There is no such Voice Changer engine file.' : 'That Voice Changer engine file could not be sent.');
}

/**
 * Mount the engine on an Express app. Returns { version, dir, router } (and `error` when the
 * manifest could not be read: then every engine address answers 503 in a sentence and the rest
 * of the site boots as usual).
 * opts.dir: the engine folder (tests point it at the real one or a copy). opts.logger: { error }.
 */
function mountEngine(app, opts = {}) {
  const dir = opts.dir || ENGINE_DIR;
  let version;
  try {
    version = engineVersion(dir);
  } catch (err) {
    (opts.logger || console).error(`[voice-changer] engine not served, manifest unreadable: ${(err && err.message) || err}`);
    const closed = (_req, res) =>
      res
        .status(503)
        .set('Cache-Control', 'no-store')
        .type('text/plain')
        .send('The Voice Changer engine is not ready on the server just now. Please try again later.');
    app.use('/vc-engine/:ver', closed);
    return { version: null, dir, router: closed, error: err };
  }
  const router = express.Router({ mergeParams: true });

  router.use((req, res, next) => {
    const ver = String(req.params.ver || '');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(ver) || isPrivatePath(req.path)) return notFound(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      return notFound(res, 405);
    }
    res.set('Access-Control-Allow-Origin', '*');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', ver === version ? IMMUTABLE : 'no-cache');
    return next();
  });

  router.use(
    express.static(dir, {
      fallthrough: false,
      dotfiles: 'deny',
      index: false,
      redirect: false,
      cacheControl: false,
      setHeaders(res, filePath) {
        const type = TYPES[path.extname(filePath).toLowerCase()];
        if (type) res.setHeader('Content-Type', type);
      },
    }),
  );

  // serve-static hands every miss (and a refused dot file) here because fallthrough is off.
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    const status = Number(err && (err.status || err.statusCode)) || 500;
    if (res.headersSent) return res.end();
    if (status === 405) {
      res.set('Allow', 'GET, HEAD');
      return notFound(res, 405);
    }
    return notFound(res, status === 403 || status === 404 || status === 400 ? 404 : 500);
  });

  app.use('/vc-engine/:ver', router);
  return { version, dir, router };
}

module.exports = { mountEngine, engineVersion, isPrivatePath, ENGINE_DIR };
