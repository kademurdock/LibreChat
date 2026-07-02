const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeAsset — every generated video/image a user creates, so they have a
 * permanent "My Creations" gallery (route: /my-creations, api: /api/kade/my-assets).
 *
 * One document per asset:
 *   - kind    : 'video' | 'image'
 *   - service : 'fal_video' | 'fal_image' | 'flux'
 *   - url     : where the media lives. fal.media URLs are durable CDN links;
 *               flux assets are saved locally first and store the LibreChat
 *               /images/<userId>/<file> path (BFL delivery URLs expire fast).
 *   - prompt  : the prompt used (may be empty for two-phase video checks)
 *
 * Bespoke to Kade's instance; same no-TS-build pattern as kadeUsage.js.
 * logKadeAsset is fire-and-forget and NEVER throws into the request path.
 */
const kadeAssetSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    kind: { type: String, enum: ['video', 'image'], index: true },
    service: { type: String },
    url: { type: String },
    prompt: { type: String },
    model: { type: String },
    costUSD: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);
kadeAssetSchema.index({ user: 1, createdAt: -1 });

const KadeAsset =
  mongoose.models.KadeAsset || mongoose.model('KadeAsset', kadeAssetSchema, 'kadeassets');

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
    await KadeAsset.create({
      user: userId,
      kind,
      service,
      url: String(url).slice(0, 2048),
      prompt: prompt ? String(prompt).slice(0, 2000) : undefined,
      model,
      costUSD: typeof costUSD === 'number' ? costUSD : 0,
      metadata,
    });
  } catch (error) {
    logger.warn('[logKadeAsset] failed (non-fatal):', error.message);
  }
}

module.exports = { KadeAsset, logKadeAsset };
