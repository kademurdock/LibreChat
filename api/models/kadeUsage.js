const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { isAdminRole, userPriceFactor, extraChargeUSD } = require('../server/services/kadeRealCost');

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
 *
 * Part 295 (Sep 26 2026): costUSD stays the REAL provider cost (her readouts);
 * chargedUSD is what the person's balance paid for it (the platform factor x
 * costUSD, 0 for the administrator). Rows written before Part 295 have no
 * chargedUSD and were charged at 1x, so readers use CHARGED_USD below.
 */
const kadeUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    service: { type: String, index: true },
    quantity: { type: Number, default: 0 },
    unit: { type: String },
    costUSD: { type: Number, default: 0 },
    chargedUSD: { type: Number },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true },
);

const KadeUsage =
  mongoose.models.KadeUsage || mongoose.model('KadeUsage', kadeUsageSchema, 'kadeusage');

/** Per-unit USD rates. */
const RATES = {
  // KADE July 21 2026 (Kade's explicit pick via AskUserQuestion: "Free --
  // included in my plan"): voice does NOT draw from user balances. Her real
  // Inworld plan is founder/creator -- 25,000,000 characters/month INCLUDED
  // in the subscription she already pays, overage $10 per 1M after that.
  // The old rate here ($5/1e6, commented "Inworld 1.5 tier") was stale and
  // matched neither number. Characters are still LOGGED per user (quantity)
  // so /usage-dashboard's pool meter can watch the 25M ceiling -- if the
  // family ever gets close, flip this to 10 / 1e6 and every page picks it
  // up automatically (costs are computed at write time; old rows keep the
  // cost they were written with, by design -- see schema comment above).
  // Sep 25 2026 (Part 291): her receipts correct the plan to $25 of credit at $10 per
  // million characters, about 2.5M characters a month, not 25M. Speech stays free to
  // users; the meter's numbers live in server/services/kadeSpeechMeter.js (env).
  tts: 0,
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
 * Part 295: described-video rows its wallet never charges: dialogue timing on the platform's credit
 * (kind '...-included') and voice samples (job 'voice-sample', reserved at 0 and never settled).
 */
function describedVideoIncluded(metadata) {
  return /-included$/.test(String(metadata?.kind || '')) || metadata?.job === 'voice-sample';
}

/** Part 295: what a person paid, in an aggregation. Rows from before Part 295 were charged 1x. */
const CHARGED_USD = { $ifNull: ['$chargedUSD', '$costUSD'] };

/**
 * Takes usd from an EXISTING Balance record (a negative usd gives it back, for a refund row): no
 * record = no grant = no-op. No floor.
 */
async function debit(userId, usd) {
  const Balance = mongoose.models.Balance;
  if (!Balance) return;
  const credits = Math.round(usd * 1e6);
  if (!credits) return;
  await Balance.updateOne({ user: userId }, { $inc: { tokenCredits: -credits } });
}

/** The account's role (null when there is no User model or no such account). Throws on a DB error. */
async function roleOf(userId) {
  const User = mongoose.models.User;
  if (!User) return null;
  const u = await User.findById(userId).select('role').lean();
  return u ? u.role || null : null;
}

/**
 * Part 295: the factor a person's quotes are shown at (1 for the administrator, the platform factor
 * for everyone else), for a caller that only has the id. Never throws; a failed lookup quotes 1x.
 */
async function priceFactorForUser(userId) {
  try {
    return userId ? userPriceFactor(await roleOf(userId)) : 1;
  } catch (_) {
    return 1;
  }
}

/**
 * Part 295: what this person pays for something that really cost costUSD (0 for the
 * administrator), for a record kept beside kadeusage (a My Creations asset). undefined when the
 * account could not be read, so the caller leaves the field out. Never throws.
 */
async function chargedFor(userId, costUSD) {
  try {
    return extraChargeUSD(costUSD, await roleOf(userId));
  } catch (_) {
    return undefined;
  }
}

/**
 * KADE prepaid Stage A (2026-07-05): non-LLM services (fal/tts/flux/tavily/phone/
 * debate) draw from the SAME wallet as LLM tokens. 1,000,000 tokenCredits = $1.
 * Admins (Kade) are exempt. Only touches an EXISTING Balance record, so this is
 * inert until balance is enabled (no record = no grant = no-op). Never throws.
 * Part 295: takes exactly usd, so pass the CHARGED price; logKadeUsage works it out itself.
 */
async function deductKadeCredits(userId, usd) {
  try {
    if (!userId || !(usd > 0)) return;
    if (isAdminRole(await roleOf(userId))) return; // Kade uncapped
    await debit(userId, usd);
  } catch (err) {
    try {
      logger.warn(`[KadeUsage] credit deduct failed: ${err && err.message}`);
    } catch (_) {
      /* noop */
    }
  }
}

/**
 * Fire-and-forget usage logger. NEVER throws.
 *
 * Part 295, her words: "Yes, double everything." costUSD is the REAL cost and is written as it
 * is; the balance pays chargedUSD = the platform factor x costUSD (kadeRealCost.extraChargeUSD),
 * nothing for the administrator. A caller that charged a wallet itself passes chargedUSD (or, for
 * a described-video row, metadata.chargedUSD) to say what it charged. A described-video row
 * without one is written at 1x, what its wallet charges today (0 for the included dialogue timing
 * and voice samples it never charges); the wallet's own reservation and settlement already took
 * that money, so it is never debited here.
 *
 * A negative costUSD is a refund row (FalAI refundVideoCharge): it gives back chargedUSD (<= 0,
 * what the original row charged) or, without one, the platform factor x the refunded cost.
 * Before Part 295 a refund row was written but the balance was never given the money back.
 */
async function logKadeUsage({ userId, service, quantity, unit, costUSD, chargedUSD, metadata }) {
  try {
    if (!userId || !quantity || quantity <= 0) {
      return;
    }
    const cost = typeof costUSD === 'number' ? costUSD : (RATES[service] || 0) * quantity;
    const walletHandled =
      service === 'describe' &&
      metadata?.source === 'described-video' &&
      metadata?.walletHandled === true;
    const refund = cost < 0;
    const said = [chargedUSD, walletHandled ? metadata?.chargedUSD : undefined].find(
      (v) => typeof v === 'number' && Number.isFinite(v) && (refund ? v <= 0 : v >= 0),
    );
    let charged = 0;
    if (cost !== 0 || said) {
      let role = null;
      let known = true;
      try {
        role = await roleOf(userId);
      } catch (err) {
        known = false; /* an unknown payer is never charged: it might be Kade */
        logger.warn(`[KadeUsage] role lookup failed, ${service} not charged: ${err && err.message}`);
      }
      if (known && !isAdminRole(role)) {
        if (said !== undefined) charged = said;
        else if (refund) charged = -extraChargeUSD(-cost, role);
        else if (walletHandled) charged = describedVideoIncluded(metadata) ? 0 : cost;
        else charged = extraChargeUSD(cost, role);
      }
    }
    await KadeUsage.create({ user: userId, service, quantity, unit, costUSD: cost, chargedUSD: charged, metadata });
    if (!walletHandled && charged !== 0) {
      await debit(userId, charged);
    }
  } catch (err) {
    try {
      logger.warn(`[KadeUsage] failed to log ${service} usage: ${err && err.message}`);
    } catch (_) {
      /* noop */
    }
  }
}

module.exports = {
  KadeUsage,
  logKadeUsage,
  deductKadeCredits,
  priceFactorForUser,
  chargedFor,
  CHARGED_USD,
  fluxCost,
  RATES,
  FLUX_ENDPOINT_USD,
};
