/**
 * REVERIE SOUND SEED — one-time insert of MooSound documents for sounds
 * whose files are already in B2 but weren't installed via @sound.
 *
 * Idempotent: skips any scopeId that already exists.
 * Runs once at startup (called from world.js route init).
 *
 * Aug 13 2026 — session 2 sounds: chords, socials, forage, garden, coins.
 * Aug 13 2026 — round 9: the strays' voices, the rest of the soul, garden.pick.
 */
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { logger } = require('@librechat/data-schemas');
const LIFE_SOUNDS = require('./lifeSounds.json');

const SOUNDS_TO_SEED = [
  // Room chord — 1-8 people present
  'chord.1',
  'chord.2',
  'chord.3',
  'chord.4',
  'chord.5',
  'chord.6',
  'chord.7',
  'chord.8',
  // Social emotes
  'social.clap',
  'social.snap',
  'social.handshake',
  // Economy
  'obj.coins.drop',
  // Forage & garden
  'forage.pick',
  'garden.plant',
  'garden.water',
  /* Round 9 (Aug 13 2026, evening) — the strays and the rest of the soul.
   * All ten uploaded to B2, presigned, and FETCHED BACK before this list was
   * touched, per the standing rule that an install reporting success is not
   * an install that works.
   *
   * NOT IN THIS LIST ON PURPOSE — three ids the engine emits and B2 does not
   * hold, because Seed Audio could not make them and a wrong sound is worse
   * than none:
   *   life.cat.hiss    best of three takes reads as an aerosol can
   *   life.dog.whine   best of three reads as a rubber squeaky toy
   *   life.stray.bolt  all three read as machinery (drill / shutter / can)
   * Each is a sustained or fine-grained animal sound with no scene around it,
   * which is the same failure family as the close train horn. The next attempt
   * should CUT rather than BUILD: generate a dense take (a cat crossing a
   * porch a dozen times) and slice on measured attacks. The engine already
   * falls back to silence for an id with no file, so nothing is broken while
   * they are missing.
   *
   * The four VOICED socials — social.laugh, social.sigh, social.hum,
   * social.cry — are deliberately absent too, and not because they failed.
   * They belong to the voice lane, not to foley: one generic laugh playing for
   * every character in the city is a Veil break by construction, and the
   * engine comment beside SOCIALS has said so since round 7. */
  'life.cat.meow',
  'life.cat.purr',
  'life.dog.bark',
  'life.dog.growl',
  'life.dog.pant',
  'social.cough',
  'social.whistle',
  'social.hug',
  'social.fistbump',
  'garden.pick',
  'hangout.seat',
  'hangout.page',
  'hangout.record',
  'hangout.snacks',
  ...Object.keys(LIFE_SOUNDS),
];

/* NOT latched on entry any more. The old version set `_seeded = true` as its
 * first statement, so a failure — and every single boot WAS a failure, see the
 * note in world.js — permanently disabled the seeder for that process. It is
 * set on SUCCESS now, which is the only event that should stop it trying. */
let _seeded = false;

async function seedSounds() {
  if (_seeded) return;

  try {
    const { MooSound } = require('~/models/kadeMoo');
    const rooms = {
      alder_trail: 'amb.woods.day',
      reedbank_creek: 'amb.creek.bank',
      alder_camp: 'amb.camp.fire',
      alder_hide: 'amb.woods.day',
      pats_diner: 'amb.diner.quiet',
      the_archive: 'amb.archive.quiet',
      ferry_dock_hook: 'amb.ferry.quiet',
      gully_laundry: 'amb.laundry.quiet',
    };
    for (const [scopeId, eventId] of Object.entries(rooms)) {
      if (LIFE_SOUNDS[eventId])
        await MooSound.updateOne(
          { scopeType: 'room', scopeId },
          { $setOnInsert: { url: LIFE_SOUNDS[eventId], addedBy: 'seed153' } },
          { upsert: true },
        );
    }

    const existing = await MooSound.find({ scopeType: 'event' }).lean();
    const existingIds = new Set(existing.map((r) => r.scopeId));

    const needed = SOUNDS_TO_SEED.filter((id) => !existingIds.has(id));
    if (!needed.length) {
      _seeded = true;
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
      const url =
        LIFE_SOUNDS[id] ||
        (id.startsWith('hangout.')
          ? `https://kademurdock.com/assets/sounds/reverie/${id}.m4a`
          : await getSignedUrl(s3, cmd, { expiresIn: expiry }));

      await MooSound.updateOne(
        { scopeType: 'event', scopeId: id },
        { $setOnInsert: { url, addedBy: 'seed' } },
        { upsert: true },
      );
      installed++;
    }

    _seeded = true;
    logger.info(`[seed] installed ${installed} new sounds (${existingIds.size} already existed)`);
  } catch (e) {
    /* Log the WHOLE error. The previous version logged `e.message` and printed
     * an empty string every boot for a day, which is how a broken seeder hid
     * in plain sight in a log everybody could read. */
    logger.error(
      '[seed] sound seed failed (will retry on next /sounds):',
      e && (e.stack || e.message || String(e)),
    );
  }
}

/* PRESIGN OUR OWN (Sep 6 2026). The manifest used to hand every stored URL to
 * LibreChat's getNewS3URL, and upstream's parseS3Key now insists on a
 * basePath/userId/fileName shape — `reverie-sounds/<id>.m4a` has two parts,
 * so it returned undefined for every row, JSON dropped the undefineds, and
 * the live manifest served {} — 66 designed sounds silent for weeks, on web
 * and native alike, with nothing in any log. This signs the city's own keys
 * with the same credentials the seeder uses, cached an hour per key. */
const _signed = new Map();
// Part173: these ten original ward beds measured only 0.003–0.006 RMS.
// Gain-only playback copies retain their stereo, timing and dynamics; original
// B2 files and MooSound rows stay intact. A new URL invalidates phone caches.
const LEVELED_WARDS = new Set([
  'bellward',
  'fairlawn',
  'gate',
  'gravewalk',
  'hook',
  'longacre',
  'millrace',
  'patch',
  'sweetwater',
  'tanglefoot',
]);
function leveledReverieUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const match = /^\/Kademurdockchat\/reverie-sounds\/amb\.([a-z]+)\.m4a$/.exec(parsed.pathname);
  if (!match || !LEVELED_WARDS.has(match[1]) || !parsed.hostname.endsWith('.backblazeb2.com'))
    return null;
  return `https://kademurdock.com/assets/sounds/reverie/levels173/amb.${match[1]}.m4a`;
}
function s3Client() {
  return new S3Client({
    endpoint: process.env.AWS_ENDPOINT_URL || process.env.AWS_S3_ENDPOINT,
    region: process.env.AWS_REGION || process.env.AWS_S3_REGION || 'us-east-005',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}
async function presignReverieUrl(url) {
  const leveled = leveledReverieUrl(url);
  if (leveled) return leveled;
  const m = /\/(reverie-(?:sounds|radio)\/[^?]+)/.exec(String(url || ''));
  if (!m) return null;
  const key = decodeURIComponent(m[1]);
  const hit = _signed.get(key);
  if (hit && hit.until > Date.now()) return hit.url;
  const bucket = process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET || 'Kademurdockchat';
  const expiry = Math.min(parseInt(process.env.S3_URL_EXPIRY_SECONDS, 10) || 604800, 604800);
  const fresh = await getSignedUrl(s3Client(), new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: expiry,
  });
  _signed.set(key, { url: fresh, until: Date.now() + 60 * 60 * 1000 });
  return fresh;
}

module.exports = { seedSounds, presignReverieUrl, leveledReverieUrl };
