const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

/**
 * KadeUsage — per-user, server-side API usage that LibreChat does NOT already
 * record in `transactions` (LLM spend is already tracked there).
 *
 * One document per billable event:
 *   - tts   : quantity = characters synthesized, unit = 'chars'
 *   - flux  : quantity = images generated,       unit = 'images'
 *   - tavily: quantity = search requests,        unit = 'searches'
 *
 * costUSD is computed at write time from the rates below so the digest/route can
 * sum it directly, but quantity+unit are kept so cost can be recomputed if a
 * rate ever changes. Bespoke to Kade's instance; lives outside data-schemas so
 * it needs no TS build step.
 */
const kadeUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    service: { type: String, index: true },
    quantity: { type: Number, default: 0 },
    unit: { type: String },
    costUSD: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

const KadeUsage =
  mongoose.models.KadeUsage || mongoose.model('KadeUsage', kadeUsageSchema, 'kadeusage');

/** Per-unit USD rates. */
const RATES = {
  tts: 5 / 1e6, // $5 / 1M characters (Inworld 1.5 tier)
  flux: 0.025, // $0.025 / image (flux-dev default; overridden per-endpoint below)
  tavily: 0.008, // ~$0.008 / search
};

/** Flux per-endpoint pricing (USD/image). */
const FLUX_ENDPOINT_USD = {
  '/v1/flux-pro-1.1-ultra': 0.06,
  '/v1/flux-pro-1.1': 0.04,
  '/v1/flux-pro': 0.05,
  '/v1/flux-dev': 0.025,
  '/v1/flux-pro-finetuned': 0.06,
  '/v1/flux-pro-1.1-ultra-finetuned': 0.07,
};

function fluxCost(endpoint, images = 1) {
  const rate = FLUX_ENDPOINT_USD[endpoint] != null ? FLUX_ENDPOINT_USD[endpoint] : RATES.flux;
  return rate * images;
}

/**
 * Fire-and-forget usage logger. NEVER throws.
 */
async function logKadeUsage({ userId, service, quantity, unit, costUSD, metadata }) {
  try {
    if (!userId || !quantity || quantity <= 0) {
      return;
    }
    const cost = typeof costUSD === 'number' ? costUSD : (RATES[service] || 0) * quantity;
    await KadeUsage.create({ user: userId, service, quantity, unit, costUSD: cost, metadata });
  } catch (err) {
    try {
      logger.warn(`[KadeUsage] failed to log ${service} usage: ${err && err.message}`);
    } catch (_) {
      /* noop */
    }
  }
}

module.exports = { KadeUsage, logKadeUsage, fluxCost, RATES, FLUX_ENDPOINT_USD };
