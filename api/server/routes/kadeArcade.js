/* /api/kade/arcade (Oct 18 2026): the Arcade's catalog, game manifests and one-hour signed pack
 * links. packages/api arcade/router.ts holds every route and the family-shelf gate; its ARCADE.md
 * is the contract. This file only wires the private bucket (read-only here), the Library's
 * signGet and isChild, shared rate limiters, and the logger. Game files never pass through the
 * server and never live in this repository. */
const rateLimit = require('express-rate-limit');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { logger } = require('@librechat/data-schemas');
const { initializeS3, createArcadeRouter, limiterCache } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { signGet, isChild } = require('./kadeReadingRoom')._internals;

const BUCKET = () => process.env.KADE_MEDIA_BUCKET || process.env.AWS_BUCKET_NAME || '';

/** The object's bytes; null when the bucket has no such object (no catalog yet is an empty arcade). */
async function loadObject(key) {
  const client = initializeS3();
  if (!client || !BUCKET()) throw new Error('arcade storage is not configured');
  let out;
  try {
    out = await client.send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
  } catch (e) {
    if (
      e &&
      (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)
    ) {
      return null;
    }
    throw e;
  }
  return Buffer.from(await out.Body.transformToByteArray());
}

/* A report every five seconds is 12 a minute; 30 leaves room for timer drift and retries. */
const diagLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  handler: (_req, res) =>
    res.status(429).json({ error: 'That is a lot of reports at once. Try again in a minute.' }),
  keyGenerator: (req) => String(req.user?.id || ''),
  store: limiterCache('kade_arcade_diag_limiter'),
});

/* Manifests and pack links: a download needs a handful a minute. Each made-up version can cost a
 * storage read, so this is the ceiling per account. */
const readLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  handler: (_req, res) =>
    res
      .status(429)
      .set('Cache-Control', 'no-store')
      .json({ error: 'That is a lot of arcade requests at once. Try again in a minute.' }),
  keyGenerator: (req) => String(req.user?.id || ''),
  store: limiterCache('kade_arcade_read_limiter'),
});

/* Add a game: one /match per ROM the person adds, in a bucket of its own, so adding a pile of
 * ROMs at once never blocks a download. A 429 here means "ask again in a minute", never "no pack". */
const matchLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  handler: (_req, res) =>
    res.status(429).set('Cache-Control', 'no-store').json({
      error: 'That is a lot of games to check at once. The rest will be checked in a minute.',
    }),
  keyGenerator: (req) => String(req.user?.id || ''),
  store: limiterCache('kade_arcade_match_limiter'),
});

module.exports = createArcadeRouter({
  auth: requireJwtAuth,
  child: isChild,
  loadObject,
  signGet: (key, mime, seconds) => signGet(key, mime, seconds),
  diag: (row) => logger.info(`[arcade/diag] ${JSON.stringify(row)}`),
  diagLimit,
  readLimit,
  matchLimit,
  /* The daily cap on locked /match answers (distinct family-shelf ROMs an account outside the
   * Family feature pack may ask about), kept a day in Redis when it is on; the router sets the
   * window. Without Redis the router counts per process, as the limiters above do. */
  matchLockedStore: limiterCache('kade_arcade_match_locked'),
  log: (message) => logger.warn(`[arcade] ${message}`),
});
