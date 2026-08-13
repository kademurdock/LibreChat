/**
 * REVERIE SOUND SEED — one-time insert of MooSound documents for sounds
 * whose files are already in B2 but weren't installed via @sound.
 *
 * Idempotent: skips any scopeId that already exists.
 * Runs once at startup (called from world.js route init).
 *
 * Aug 13 2026 — session 2 sounds: chords, socials, forage, garden, coins.
 */
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { logger } = require('@librechat/data-schemas');

const SOUNDS_TO_SEED = [
  // Room chord — 1-8 people present
  'chord.1', 'chord.2', 'chord.3', 'chord.4',
  'chord.5', 'chord.6', 'chord.7', 'chord.8',
  // Social emotes
  'social.clap', 'social.snap', 'social.handshake',
  // Economy
  'obj.coins.drop',
  // Forage & garden
  'forage.pick', 'garden.plant', 'garden.water',
];

let _seeded = false;

async function seedSounds() {
  if (_seeded) return;
  _seeded = true;

  try {
    const { MooSound } = require('~/models/kadeMoo');

    const existing = await MooSound.find({ scopeType: 'event' }).lean();
    const existingIds = new Set(existing.map((r) => r.scopeId));

    const needed = SOUNDS_TO_SEED.filter((id) => !existingIds.has(id));
    if (!needed.length) {
      logger.info(`[seed] all ${SOUNDS_TO_SEED.length} sounds already installed`);
      return;
    }

    /* Build presigned URLs using the same AWS env the service already has */
    const s3 = new S3Client({
      endpoint: process.env.AWS_ENDPOINT_URL || process.env.AWS_S3_ENDPOINT,
      region: process.env.AWS_REGION || process.env.AWS_S3_REGION || 'us-east-005',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    });

    const bucket = process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET || 'Kademurdockchat';
    const expiry = parseInt(process.env.S3_URL_EXPIRY_SECONDS, 10) || 604800;

    let installed = 0;
    for (const id of needed) {
      const key = `reverie-sounds/${id}.m4a`;
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      const url = await getSignedUrl(s3, cmd, { expiresIn: expiry });

      await MooSound.updateOne(
        { scopeType: 'event', scopeId: id },
        { $set: { url, addedBy: 'seed' } },
        { upsert: true },
      );
      installed++;
    }

    logger.info(`[seed] installed ${installed} new sounds (${existingIds.size} already existed)`);
  } catch (e) {
    logger.error('[seed] sound seed failed (non-fatal):', e.message);
  }
}

module.exports = { seedSounds };
