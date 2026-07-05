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
  // phone / fal_video / fal_image events always arrive with an explicit
  // costUSD (bridge posts real Twilio price; FalAI computes per-second fal
  // pricing), so they need no per-unit rate here.
  flux: 0.025, // $0.025 / image (flux-dev default; overridden per-endpoint below)
  tavily: 0.008, // ~$0.008 / search
};

/** Flux per-endpoint pricing (USD/image). */
const FLUX_ENDPOINT_USD = {
  '/v1/flux-2-pro-preview': 0.03,
  '/v1/flux-2-pro': 0.03,
  '/v1/flux-2-flex': 0.06,
  '/v1/flux-2-klein-9b-preview': 0.015,
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
 * KADE prepaid Stage A (2026-07-05): non-LLM services (fal/tts/flux/tavily/phone/
 * debate) draw from the SAME wallet as LLM tokens. 1,000,000 tokenCredits = $1.
 * Admins (Kade) are exempt. Only touches an EXISTING Balance record, so this is
 * inert until balance is enabled (no record = no grant = no-op). Never throws.
 */
async function deductKadeCredits(userId, costUSD) {
  try {
    if (!userId || !costUSD || costUSD <= 0) return;
    const User = mongoose.models.User;
    if (User) {
      const u = await User.findById(userId).select('role').lean();
      if (u && String(u.role).toUpperCase() === 'ADMIN') return; // Kade uncapped
    }
    const Balance = mongoose.models.Balance;
    if (!Balance) return;
    const credits = Math.round(costUSD * 1e6);
    if (credits <= 0) return;
    await Balance.updateOne({ user: userId }, { $inc: { tokenCredits: -credits } });
  } catch (err) {
    try { logger.warn(`[KadeUsage] credit deduct failed: ${err && err.message}`); } catch (_) { /* noop */ }
  }
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
    await deductKadeCredits(userId, cost);
  } catch (err) {
    try {
      logger.warn(`[KadeUsage] failed to log ${service} usage: ${err && err.message}`);
    } catch (_) {
      /* noop */
    }
  }
}

module.exports = { KadeUsage, logKadeUsage, deductKadeCredits, fluxCost, RATES, FLUX_ENDPOINT_USD };
