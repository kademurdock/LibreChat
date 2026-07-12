const axios = require('axios');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeAsset — every generated video/image a user creates, so they have a
 * permanent "My Creations" gallery (route: /my-creations, api: /api/kade/my-assets).
 *
 * One document per asset:
 *   - kind        : 'video' | 'image'
 *   - service     : 'fal_video' | 'fal_image' | 'flux'
 *   - url         : where the media lives. fal.media URLs are durable CDN links;
 *                   flux assets are saved via the file pipeline (S3-signed or local path).
 *   - prompt      : the prompt used (may be empty for two-phase video checks)
 *   - description : AI vision description of the media, written for a blind
 *                   user (filled in asynchronously after creation)
 *   - backupUrl   : our own Backblaze (S3) mirror of the media, so the gallery
 *                   never rots if the fal.media link ever dies (videos only)
 *   - shared      : user opted this item onto the communal /wall-of-fame page
 *
 * Bespoke to Kade's instance; same no-TS-build pattern as kadeUsage.js.
 * logKadeAsset is fire-and-forget and NEVER throws into the request path.
 * After the doc is created, enrichment (B2 mirror + vision description) runs
 * detached — failures there only log a warning.
 */
const kadeAssetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    kind: { type: String, enum: ['video', 'image', 'audio'], index: true },
    service: { type: String },
    url: { type: String },
    prompt: { type: String },
    model: { type: String },
    costUSD: { type: Number, default: 0 },
    description: { type: String },
    backupUrl: { type: String },
    shared: { type: Boolean, default: false, index: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);
kadeAssetSchema.index({ user: 1, createdAt: -1 });

const KadeAsset =
  mongoose.models.KadeAsset || mongoose.model('KadeAsset', kadeAssetSchema, 'kadeassets');

/** Resolve a stored asset URL to something fetchable server-side. */
function absoluteUrl(url) {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) {
    return u;
  }
  const base = (process.env.DOMAIN_SERVER || 'https://kademurdock.com').replace(/\/$/, '');
  return base + (u.startsWith('/') ? u : '/' + u);
}

/* ----------------------------------------------------------------------------
 * Backblaze mirror — videos only. fal.media links are durable but not
 * guaranteed forever; we already pay for B2 (mongo backups + avatars), so a
 * copy there means the gallery never rots. Uses the same S3 storage the rest
 * of LibreChat uses. Returns the signed URL of the mirror (re-signed at read
 * time by /api/kade/my-assets) or null.
 * Disable with KADE_ASSET_MIRROR=0.
 * -------------------------------------------------------------------------- */
async function mirrorAsset(doc) {
  try {
    if (process.env.KADE_ASSET_MIRROR === '0') {
      return null;
    }
    if ((doc.kind !== 'video' && doc.kind !== 'audio') || !/^https?:\/\//i.test(String(doc.url || ''))) {
      return null;
    }
    const { saveURLToS3 } = require('@librechat/api');
    if (typeof saveURLToS3 !== 'function') {
      return null;
    }
    const isAudio = doc.kind === 'audio';
    const fileName = `kade-${doc._id}.${isAudio ? 'mp3' : 'mp4'}`;
    const signedUrl = await saveURLToS3({
      userId: String(doc.user),
      URL: doc.url,
      fileName,
      basePath: isAudio ? 'audios' : 'videos',
    });
    return signedUrl || null;
  } catch (err) {
    logger.warn('[kadeAsset] mirror failed (non-fatal):', err.message);
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * Vision description — every generated asset gets a rich, blind-friendly
 * description via a cheap vision model on OpenRouter (Gemini handles both
 * images AND video). Media is downloaded server-side and sent inline as
 * base64 (Google's provider refuses to fetch URLs itself — verified live).
 * Falls back to a prompt-based text description for videos if the vision
 * call fails. Disable with KADE_ASSET_DESCRIBE=0.
 * -------------------------------------------------------------------------- */
const DESCRIBE_MODEL = process.env.KADE_VISION_MODEL || 'google/gemini-3.1-flash-lite';
const MAX_MEDIA_BYTES = 30 * 1024 * 1024;

async function openRouterChat(content, maxTokens = 260, usageOwner = null) {
  const key = process.env.OPENROUTER_KEY;
  if (!key) {
    return null;
  }
  const r = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    /* July 13 2026 money audit: request usage so gallery descriptions stop
     * being the one billable call that never hit kadeusage. */
    { model: DESCRIBE_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }], usage: { include: true } },
    { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 90000 },
  );
  if (usageOwner) {
    try {
      const u = r.data?.usage || {};
      const cost = typeof u.cost === 'number' ? u.cost : 0;
      const { logKadeUsage } = require('~/models/kadeUsage');
      logKadeUsage({
        userId: String(usageOwner),
        service: 'describe',
        quantity: 1,
        unit: 'items',
        costUSD: cost,
        metadata: { source: 'gallery_auto_description', model: DESCRIBE_MODEL },
      });
    } catch { /* logging must never break a description */ }
  }
  const text = r.data?.choices?.[0]?.message?.content;
  return typeof text === 'string' ? text.trim() : null;
}

const DESCRIBE_INSTRUCTION =
  'Describe this for a blind person as their eyes. 2-4 sentences, vivid and concrete: subjects, colors, ' +
  'lighting, mood, composition, any text that appears, and (for video) what happens over time. ' +
  'No preamble like "This image shows" — start straight in on the scene.';

async function describeAudio(doc) {
  try {
    if (process.env.KADE_ASSET_DESCRIBE === '0' || !process.env.OPENROUTER_KEY || !doc.prompt) {
      return null;
    }
    const text = await openRouterChat(
      [
        {
          type: 'text',
          text:
            `This is an AI-generated AUDIO clip (any mix of dialogue, sound effects, music, and narration) created from this direction: "${String(doc.prompt).slice(0, 1500)}". ` +
            'In 2-4 sentences, tell a blind listener what they will HEAR: who speaks and their tone/emotion, key sound effects, any music, and the overall atmosphere. ' +
            'Start straight in with "You will hear" — no other preamble.',
        },
      ],
      220,
      doc.user,
    );
    return text ? text.slice(0, 2000) : null;
  } catch (err) {
    logger.warn('[kadeAsset] audio describe failed:', err.message);
    return null;
  }
}

async function describeAsset(doc) {
  try {
    if (process.env.KADE_ASSET_DESCRIBE === '0' || !process.env.OPENROUTER_KEY) {
      return null;
    }
    if (doc.kind === 'audio') {
      return await describeAudio(doc);
    }
    const src = absoluteUrl(doc.url);
    const media = await axios.get(src, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: MAX_MEDIA_BYTES,
      maxBodyLength: MAX_MEDIA_BYTES,
      headers: { 'User-Agent': 'Mozilla/5.0 (kade-ai gallery describer)' },
    });
    let mime = String(media.headers?.['content-type'] || '').split(';')[0].trim();
    if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
      mime = doc.kind === 'video' ? 'video/mp4' : 'image/png';
    }
    const b64 = Buffer.from(media.data).toString('base64');
    const dataUrl = `data:${mime};base64,${b64}`;
    const part =
      doc.kind === 'video'
        ? { type: 'video_url', video_url: { url: dataUrl } }
        : { type: 'image_url', image_url: { url: dataUrl } };
    const text = await openRouterChat([{ type: 'text', text: DESCRIBE_INSTRUCTION }, part], 260, doc.user);
    if (text) {
      return text.slice(0, 2000);
    }
    throw new Error('empty description');
  } catch (err) {
    logger.warn('[kadeAsset] vision describe failed:', err.message);
    // Fallback (videos especially): describe from the prompt so the gallery
    // entry is never a mystery to a screen-reader user.
    try {
      if (!doc.prompt) {
        return null;
      }
      const text = await openRouterChat([
        {
          type: 'text',
          text:
            `A short AI-generated ${doc.kind} was created from this prompt: "${doc.prompt}". ` +
            'Write 1-2 sentences telling a blind person what the result most likely looks like. ' +
            'Start with "Likely shows:" so it is clear this is inferred from the prompt.',
        },
      ], 120, doc.user);
      return text ? text.slice(0, 2000) : null;
    } catch (err2) {
      logger.warn('[kadeAsset] prompt-based describe failed too:', err2.message);
      return null;
    }
  }
}

/** Detached enrichment: mirror first (gives the describer a stable copy), then describe. */
async function enrichAsset(doc) {
  try {
    const updates = {};
    const backupUrl = await mirrorAsset(doc);
    if (backupUrl) {
      updates.backupUrl = String(backupUrl).slice(0, 2048);
    }
    const description = await describeAsset(doc);
    if (description) {
      updates.description = description;
    }
    if (Object.keys(updates).length > 0) {
      await KadeAsset.updateOne({ _id: doc._id }, { $set: updates });
      logger.info(
        `[kadeAsset] enriched ${doc._id} (${doc.kind}): ` +
          `${updates.backupUrl ? 'mirrored, ' : ''}${updates.description ? 'described' : 'no description'}`,
      );
    }
  } catch (err) {
    logger.warn('[kadeAsset] enrichAsset failed (non-fatal):', err.message);
  }
}

/**
 * Fire-and-forget asset logger. Safe to call without await.
 * @param {object} p
 * @param {string} p.userId
 * @param {'video'|'image'} p.kind
 * @param {string} p.service
 * @param {string} p.url
 * @param {string} [p.prompt]
 * @param {string} [p.model]
 * @param {number} [p.costUSD]
 * @param {object} [p.metadata]
 */
async function logKadeAsset({ userId, kind, service, url, prompt, model, costUSD, metadata }) {
  try {
    if (!userId || !url) {
      return;
    }
    const doc = await KadeAsset.create({
      user: userId,
      kind,
      service,
      url: String(url).slice(0, 2048),
      prompt: prompt ? String(prompt).slice(0, 2000) : undefined,
      model,
      costUSD: typeof costUSD === 'number' ? costUSD : 0,
      metadata,
    });
    // Enrichment runs detached; never blocks or throws into the caller.
    setImmediate(() => {
      enrichAsset(doc).catch(() => {});
    });
  } catch (error) {
    logger.warn('[logKadeAsset] failed (non-fatal):', error.message);
  }
}

module.exports = { KadeAsset, logKadeAsset };
