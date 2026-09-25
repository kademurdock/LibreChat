'use strict';
/**
 * KADE Sep 25 2026 (Part 291) — REAL PROVIDER COST, read back from the chat meter.
 *
 * Her words: "since we double costs for users, I should get the cost I will actually pay the
 * server, where everyone else gets the balance thing."
 *
 * Only voiceWalletUpdate writes (a voice caller's Balance, when KADE_VOICE_BILL_REAL is on). Every chat
 * transaction stays recorded exactly as before:
 * tokenValue = tokens x sticker x KADE_BILLING_MULTIPLIER (the platform factor, 2 since Sep 5 2026,
 * Part 131). This module works out what those same tokens really cost at the providers:
 *
 *   - Each row is RE-PRICED from its token counts at today's sticker rows: db.getMultiplier / the
 *     platform factor, cache reads and writes the same way. Not "charged / 2": before Sep 5 some
 *     rows were billed on the wrong price rows (glm-5.3-flash on the glm-5.3 row, grok-4.20 on
 *     grok-4, the $6/M default-rate hole), and interrupted replies carry upstream's 1.15, which no
 *     provider charges.
 *   - A model with no price row falls back to charged / the factor in force on that row's date:
 *     1 before 2026-09-05T05:01Z (when Part 131 went live), the platform factor after.
 *   - Only spend rows (prompt, completion) count. A positive credits row is filtered out, never
 *     netted against spend by a Math.abs over a sum.
 *   - kadeusage rows are real already (costUSD written at the provider price, charged at 1x).
 *     Never divide them; nothing in this module touches them.
 *
 * Known limits: premium long-context tiers and per-endpoint token configs are re-priced at the
 * model's standard row (a model priced only by an endpoint config has no row and falls back).
 *
 * No '~' requires at the top, so node --test loads it.
 */

const DEFAULT_SINCE = '2026-09-05T05:01:00Z';
const FACTOR_SINCE = (() => {
  const d = new Date(process.env.KADE_BILLING_FACTOR_SINCE || DEFAULT_SINCE);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_SINCE) : d;
})();
const CREDIT_USD = 1e-6;
const SPEND_TYPES = ['prompt', 'completion'];
const NUMERIC = ['int', 'long', 'double', 'decimal'];

/** KADE_BILLING_MULTIPLIER, read per call like tx.ts so a Railway change needs no deploy. */
function platformFactor(env = process.env) {
  const raw = Number(env && env.KADE_BILLING_MULTIPLIER);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

const isAdminRole = (role) => String(role || '').toUpperCase() === 'ADMIN';

/**
 * Part 291, her words: "Yes, I do want double on voice." KADE_VOICE_BILL_REAL=1 bills a voice or
 * phone chat turn from its real transaction, to the real caller, at the platform factor
 * (kadeOnBehalfOf sets req.kadeBillTo; client.js tags the rows context 'voice'). Off by default.
 */
function voiceBilledReal(env = process.env) {
  return String((env && env.KADE_VOICE_BILL_REAL) || '') === '1';
}

/** Extra _id key for txGroupStage: true on the rows a billed voice turn wrote. */
const VOICE_KEY = { $eq: ['$context', 'voice'] };

/**
 * The bridge's per-call estimate of a voice call's model turns. Every voice-stream turn goes
 * through the fork (/librechat/ask-stream), so the same turns are always in someone's real
 * transactions too: Kade's seat, or (switch on, caller-started call) the caller's own.
 */
const VOICE_ESTIMATE_SERVICE = 'voice_chat';

/**
 * POST /usage-event body -> what is written to kadeusage. With the switch on, a voice_chat
 * estimate whose call went through the fork billed to the caller (the bridge says so with
 * metadata.viaFork === true, review F40) is kept for counts but costs 0, because the real
 * transactions already charged the caller; the estimate rides along in metadata. Every other
 * voice_chat estimate (outbound calls, a bridge that predates the flag) keeps its cost, and every
 * other service is untouched.
 * @param {{ service?: string, costUSD?: unknown, metadata?: unknown }} event
 */
function voiceUsageEvent({ service, costUSD, metadata } = {}, env = process.env) {
  const cost = typeof costUSD === 'number' ? costUSD : undefined;
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null;
  if (
    !voiceBilledReal(env) ||
    String(service || '') !== VOICE_ESTIMATE_SERVICE ||
    !base ||
    base.viaFork !== true
  ) {
    return { costUSD: cost, metadata };
  }
  return {
    costUSD: 0,
    metadata: { ...base, billedBy: 'transactions', ...(cost !== undefined ? { bridgeEstimateUSD: cost } : {}) },
  };
}

/** The same fields the pre-turn check's lazy init writes (packages/api checkBalance.ts). */
function startBalanceFields(config) {
  const fields = { tokenCredits: config.startBalance };
  if (
    config.autoRefillEnabled &&
    config.refillIntervalValue != null &&
    config.refillIntervalUnit != null &&
    config.refillAmount != null
  ) {
    fields.autoRefillEnabled = config.autoRefillEnabled;
    fields.refillIntervalValue = config.refillIntervalValue;
    fields.refillIntervalUnit = config.refillIntervalUnit;
    fields.refillAmount = config.refillAmount;
    fields.lastRefill = new Date();
  }
  return fields;
}

/**
 * Review F10 + F13: the wallet writer for a voice turn billed to its caller (req.kadeBillTo),
 * used by client.js in place of db.updateBalance.
 *   - F13: a caller with no Balance record yet (or tokenCredits null) is first given the normal
 *     start balance, with the same fields the pre-turn check's lazy init writes, so a first voice
 *     call never leaves a $0 record that blocks the welcome credit. The seed only ever creates a
 *     missing record ($setOnInsert) or fills a null one; it never overwrites credits.
 *   - F10: the spend is an $inc with no floor, the way deductKadeCredits charges extras. Phone
 *     minutes posted after hang-up can leave a wallet below zero; updateBalance's
 *     Math.max(0, balance + spend) would erase that debt on the caller's next voice turn.
 * @param {{ balanceConfig?: { startBalance?: number | null } | null, Balance?: object }} [opts]
 * @returns {(args: { user: string, incrementValue: number }) => Promise<object | null>}
 */
function voiceWalletUpdate({ balanceConfig, Balance } = {}) {
  return async ({ user, incrementValue }) => {
    const Model = Balance || require('mongoose').models.Balance;
    const start = balanceConfig && balanceConfig.startBalance;
    if (start != null) {
      const current = await Model.findOne({ user }, { tokenCredits: 1 }).lean();
      if (!current) {
        await Model.updateOne({ user }, { $setOnInsert: startBalanceFields(balanceConfig) }, { upsert: true });
      } else if (current.tokenCredits == null) {
        await Model.updateOne({ user, tokenCredits: null }, { $set: { tokenCredits: start } });
      }
    }
    const inc = Number(incrementValue);
    if (!Number.isFinite(inc) || inc === 0) {
      return Model.findOne({ user }).lean();
    }
    try {
      return await Model.findOneAndUpdate({ user }, { $inc: { tokenCredits: inc } }, { upsert: true, new: true }).lean();
    } catch (e) {
      // A record with no credits yet (and no configured start) counts from 0: $inc on null throws.
      return Model.findOneAndUpdate({ user, tokenCredits: null }, { $set: { tokenCredits: inc } }, { new: true }).lean();
    }
  };
}

/**
 * Review F14: voice_chat estimates are the same turns as transactions already counted as real
 * chat (see VOICE_ESTIMATE_SERVICE), so a real total that also has those transactions must leave
 * them out. True for a kadeusage service name that is a voice estimate.
 */
function isVoiceEstimate(service) {
  return String(service || '') === VOICE_ESTIMATE_SERVICE;
}

/** The caller's $match body, limited to spend rows. */
function spendMatch(match = {}) {
  return { ...match, tokenType: { $in: SPEND_TYPES } };
}

/**
 * One bucket per (caller keys, model, tokenType, structured prompt?, after the switch-over?).
 * Token counts are summed as positive numbers; `charged` is the recorded (negative) tokenValue.
 * @param {Record<string, unknown>} [keys] extra _id fields, e.g. { user: '$user' }
 */
function txGroupStage(keys = {}) {
  return {
    $group: {
      _id: {
        ...keys,
        model: '$model',
        tokenType: '$tokenType',
        structured: { $in: [{ $type: '$inputTokens' }, NUMERIC] },
        afterSwitch: { $gte: ['$createdAt', FACTOR_SINCE] },
      },
      raw: { $sum: { $abs: { $ifNull: ['$rawAmount', 0] } } },
      input: { $sum: { $abs: { $ifNull: ['$inputTokens', 0] } } },
      write: { $sum: { $abs: { $ifNull: ['$writeTokens', 0] } } },
      read: { $sum: { $abs: { $ifNull: ['$readTokens', 0] } } },
      charged: { $sum: { $ifNull: ['$tokenValue', 0] } },
      rows: { $sum: 1 },
    },
  };
}

/**
 * Today's REAL rate in credits per token, memoised per model and kind. getMultiplierRaw is not
 * exported from data-schemas, so the platform factor is divided back out of db.getMultiplier.
 * @param {{ getValueKey: Function, getMultiplier: Function, getCacheMultiplier: Function }} db
 * @param {number} factor
 */
function createPricer(db, factor) {
  const memo = new Map();
  return (model, kind) => {
    const key = `${model}|${kind}`;
    if (memo.has(key)) return memo.get(key);
    const priced = Boolean(model && db.getValueKey(model));
    let rate = null;
    if (priced) {
      if (kind === 'write' || kind === 'read') {
        const c = db.getCacheMultiplier({ model, cacheType: kind });
        rate = c == null ? null : Math.abs(c) / factor;
      } else {
        rate = Math.abs(db.getMultiplier({ model, tokenType: kind })) / factor;
      }
    }
    const out = { rate, priced };
    memo.set(key, out);
    return out;
  };
}

/** One bucket -> { realUSD, chargedUSD, unpriced: model name or null }. */
function priceGroup(g, price, factor) {
  const id = (g && g._id) || {};
  const model = id.model || '';
  const chargedUSD = -(Number(g.charged) || 0) * CREDIT_USD;
  const main = price(model, id.tokenType);
  if (!main.priced || main.rate == null) {
    const f = id.afterSwitch ? factor : 1;
    return { realUSD: chargedUSD / f, chargedUSD, unpriced: model || '(no model)' };
  }
  let credits;
  if (id.tokenType === 'prompt' && id.structured) {
    const write = price(model, 'write').rate;
    const read = price(model, 'read').rate;
    credits =
      (Number(g.input) || 0) * main.rate +
      (Number(g.write) || 0) * (write == null ? main.rate : write) +
      (Number(g.read) || 0) * (read == null ? main.rate : read);
  } else {
    credits = (Number(g.raw) || 0) * main.rate;
  }
  return { realUSD: credits * CREDIT_USD, chargedUSD, unpriced: null };
}

/**
 * Sum priced buckets under the caller's key names.
 * @returns {Array<{ key: Record<string, unknown>, realUSD: number, chargedUSD: number, rows: number, unpricedModels: string[] }>}
 */
function rollUp(groups, keyNames, price, factor) {
  const out = new Map();
  for (const g of groups || []) {
    const id = (g && g._id) || {};
    const key = {};
    for (const k of keyNames) key[k] = id[k];
    const sig = JSON.stringify(keyNames.map((k) => (id[k] == null ? null : String(id[k]))));
    let row = out.get(sig);
    if (!row) {
      row = { key, realUSD: 0, chargedUSD: 0, rows: 0, unpriced: new Set() };
      out.set(sig, row);
    }
    const p = priceGroup(g, price, factor);
    row.realUSD += p.realUSD;
    row.chargedUSD += p.chargedUSD;
    row.rows += Number(g.rows) || 0;
    if (p.unpriced) row.unpriced.add(p.unpriced);
  }
  return [...out.values()].map((r) => ({
    key: r.key,
    realUSD: r.realUSD,
    chargedUSD: r.chargedUSD,
    rows: r.rows,
    unpricedModels: [...r.unpriced],
  }));
}

/**
 * Real chat cost, grouped by the caller's keys.
 * @param {{ Transaction: { aggregate: Function }, db: object, env?: object, match?: object, keys?: object }} opts
 */
async function realChat({ Transaction, db, env = process.env, match = {}, keys = {} }) {
  const factor = platformFactor(env);
  const price = createPricer(db, factor);
  const groups = await Transaction.aggregate([{ $match: spendMatch(match) }, txGroupStage(keys)]);
  return rollUp(groups, Object.keys(keys), price, factor);
}

/**
 * Pricing for the live chat cost gauge (and the subagent gauge). The administrator pays the
 * providers herself, so she sees the real sticker; everyone else keeps exactly db.getMultiplier and
 * db.getCacheMultiplier. Only the gauge uses this: recorded rows are priced as before.
 */
function gaugePricing(role, db, env = process.env) {
  const base = { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier };
  if (!isAdminRole(role)) return base;
  return {
    getMultiplier: (args) => base.getMultiplier(args) / platformFactor(env),
    getCacheMultiplier: (args) => {
      const c = base.getCacheMultiplier(args);
      return c == null ? null : c / platformFactor(env);
    },
  };
}

module.exports = {
  FACTOR_SINCE,
  CREDIT_USD,
  SPEND_TYPES,
  platformFactor,
  isAdminRole,
  voiceBilledReal,
  VOICE_KEY,
  VOICE_ESTIMATE_SERVICE,
  voiceUsageEvent,
  startBalanceFields,
  voiceWalletUpdate,
  isVoiceEstimate,
  spendMatch,
  txGroupStage,
  createPricer,
  priceGroup,
  rollUp,
  realChat,
  gaugePricing,
};
