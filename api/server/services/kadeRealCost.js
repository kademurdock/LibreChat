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
 *   - kadeusage rows are real already (costUSD written at the provider price). Never divide them;
 *     nothing in this module touches them. Since Part 295 a row also carries chargedUSD, what the
 *     person's balance paid (extraChargeUSD below); rows written before it were charged at 1x.
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
 * KADE Oct 20 2026, her words: "Yes: the fuller refund ($20.91), plus Amber's failed turns, stop
 * charging failed turns, record her $20 repayment, include the old chat paths, and deploy the
 * at-cost change." FAMILY AT COST: an account in the Family feature pack (packages/api
 * family/pack.ts familyPack, the Library's family permission, unchanged: the App Review seat and
 * test seats are never in it) is still CHARGED, but at factor 1, the real provider price. The
 * administrator stays exempt; everyone else stays at KADE_BILLING_MULTIPLIER.
 *
 * Every payer lookup selects PAYER_FIELDS. familyPack falls back to the Sep 24 cutoff rule when
 * kadeLibraryAccess is missing, so a lookup that left the field out could price an account Kade
 * set to 'none' at cost. A bare role STRING (the pre-Oct 20 calling style) is never family.
 *
 * KADE_FAMILY_AT_COST: absent or anything but '0' = on; '0' puts family back at the platform
 * factor. Read per call.
 */
const PAYER_FIELDS = 'role email name username kadeLibraryAccess';

function familyAtCost(env = process.env) {
  return String((env && env.KADE_FAMILY_AT_COST) ?? '').trim() !== '0';
}

/** The pack rule itself, loaded lazily so node --test still loads this file without a build. */
let familyPackResolver = null;
function familyPackRule() {
  if (familyPackResolver) return familyPackResolver;
  try {
    const fn = require('@librechat/api').familyPack;
    if (typeof fn === 'function') familyPackResolver = fn;
  } catch (_) {
    /* no build (a node test): nobody is family unless the account says so explicitly */
  }
  return familyPackResolver;
}

/** Tests only: stand in for packages/api familyPack (null puts the real one back). */
function setFamilyPackRuleForTests(fn) {
  familyPackResolver = typeof fn === 'function' ? fn : null;
}

/**
 * 'admin' | 'family' | 'user' for an account object (or a bare role string, never family).
 * An explicit account.familyPack boolean (set by trusted server code, e.g. the describer actor)
 * stands in for the lookup.
 * @param {string | { role?: string, familyPack?: boolean, kadeLibraryAccess?: string } | null | undefined} account
 */
function payerTier(account, env = process.env) {
  const role = typeof account === 'string' ? account : account && account.role;
  if (isAdminRole(role)) return 'admin';
  if (!account || typeof account !== 'object' || !familyAtCost(env)) return 'user';
  if (typeof account.familyPack === 'boolean') return account.familyPack ? 'family' : 'user';
  const rule = familyPackRule();
  try {
    return rule && rule(account) === true ? 'family' : 'user';
  } catch (_) {
    return 'user';
  }
}

/**
 * KADE Sep 26 2026 (Part 295), her words: "Yes, double everything." Every paid extra (Spotter,
 * camera video, describing, Lyria, games, the clubhouse, the debate room, fal and the rest) costs a
 * person the platform factor times its real provider price, the way chat and voice turns already
 * do. The administrator pays the providers herself: she is never charged, and every price she is
 * quoted is the real one. Quotes use userPriceFactor; the wallet uses extraChargeUSD.
 * Oct 20 2026: takes the ACCOUNT (a bare role string still works and is never family); a Family
 * pack account's factor is 1.
 */
function userPriceFactor(account, env = process.env) {
  return payerTier(account, env) === 'user' ? platformFactor(env) : 1;
}

/** What a person's balance pays for an extra that really cost costUSD: 0 for the administrator,
 * the real cost for a Family pack account, the platform factor x it for everyone else. */
function extraChargeUSD(costUSD, account, env = process.env) {
  const cost = Number(costUSD);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const tier = payerTier(account, env);
  if (tier === 'admin') return 0;
  return Math.round(cost * (tier === 'family' ? 1 : platformFactor(env)) * 1e6) / 1e6;
}

/**
 * The account `userId` names, taken from what the request already holds (req.user, or the voice
 * caller in req.kadeOnBehalfOf); null when neither is that account, so the caller keeps the
 * platform price rather than guessing.
 */
function payerFromReq(req, userId) {
  if (!req) return null;
  const id = userId == null ? null : String(userId);
  const u = req.user;
  if (u && (id == null || String(u.id ?? u._id) === id)) return u;
  const o = req.kadeOnBehalfOf;
  if (o && id != null && String(o.id ?? o._id) === id) return o;
  return null;
}

/**
 * Part 295 (her Google key inside OpenRouter, BYOK): what an OpenRouter call really cost the
 * platform. The rule, measured on live replies Sep 26 2026 (OpenRouter's docs say otherwise):
 *
 *   real cost = usage.is_byok === true ? cost + upstream_inference_cost : cost
 *
 *   - A normal reply reports { cost, is_byok: false, cost_details: { upstream_inference_cost } }
 *     with the upstream figure EQUAL to cost (e.g. cost 0.0125646, upstream 0.0125646). It is the
 *     same money said twice, never an extra charge: adding it would double every call.
 *   - With BYOK (is_byok: true), cost is only OpenRouter's own fee (often 0) and the upstream
 *     figure is what Google charged her key, so the two are summed.
 *   - The generation endpoint's record { total_cost, is_byok, upstream_inference_cost } follows the
 *     same rule; pass the whole body so its is_byok comes along.
 *   - A reply that names no own fee but an upstream figure costs that figure (right either way).
 *   - A BYOK reply with no upstream figure is not a price: the fee alone (often 0) would book a
 *     call Google billed her key for at next to nothing. It is null, as the describer's realCost
 *     leaves it undefined, so the caller prices it from its own token estimate.
 * null when neither field is a number, so each caller keeps its own fallback estimate.
 * @param {{ cost?: unknown, total_cost?: unknown, is_byok?: unknown, upstream_inference_cost?: unknown, cost_details?: { upstream_inference_cost?: unknown } } | null | undefined} usage
 * @returns {number | null}
 */
function openRouterCost(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const own = num(usage.cost) ?? num(usage.total_cost);
  const upstream = num(usage.cost_details && usage.cost_details.upstream_inference_cost) ?? num(usage.upstream_inference_cost);
  if (own == null) return upstream;
  if (usage.is_byok !== true) return own;
  return upstream != null ? own + upstream : null;
}

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
        /* Oct 20 2026: the factor stamped on the row (null on rows written before the stamp). */
        kadeFactor: { $ifNull: ['$kadeFactor', null] },
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
  const chargedUSD = -(Number(g.charged) || 0) * CREDIT_USD || 0;
  const main = price(model, id.tokenType);
  if (!main.priced || main.rate == null) {
    /* Oct 20 2026: a row stamped with kadeFactor says its own factor (1 for a Family pack row, 0
     * for an uncharged failed turn, whose real cost cannot be recovered from a charge of 0). */
    const stamped = typeof id.kadeFactor === 'number' && Number.isFinite(id.kadeFactor) ? id.kadeFactor : null;
    const f = stamped != null ? stamped : id.afterSwitch ? factor : 1;
    return { realUSD: f > 0 ? chargedUSD / f : 0, chargedUSD, unpriced: model || '(no model)' };
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
function gaugePricing(account, db, env = process.env) {
  const base = { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier };
  if (payerTier(account, env) === 'user') return base;
  return realPricing(db, env);
}

/** db's pricing with the platform factor divided back out: the raw provider sticker. */
function realPricing(db, env = process.env) {
  return {
    getMultiplier: (args) => db.getMultiplier(args) / platformFactor(env),
    getCacheMultiplier: (args) => {
      const c = typeof db.getCacheMultiplier === 'function' ? db.getCacheMultiplier(args) : null;
      return c == null ? null : c / platformFactor(env);
    },
  };
}

/**
 * Oct 20 2026: the pricing a person's CHAT transactions are recorded (and their balance charged)
 * at. A Family pack account pays the real sticker (factor 1); everyone else, the administrator
 * included (her balance is never drawn), keeps db's own platform-factor pricing exactly as before.
 * `factor` is stamped on every row as kadeFactor (transactions.ts), so an audit can tell a 1x row
 * from a 2x one without the cutover time.
 * @returns {{ getMultiplier: Function, getCacheMultiplier: Function, factor: number }}
 */
function chargePricing(account, db, env = process.env) {
  const f = platformFactor(env);
  if (payerTier(account, env) === 'family') return { ...realPricing(db, env), factor: 1 };
  return { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier, factor: f };
}

/**
 * Oct 20 2026, her words: "stop charging failed turns." A turn that ends in the agents recursion
 * limit ("Recursion limit of N reached") is recorded at factor 0: every row keeps its token counts
 * (so the real-cost readouts, which re-price tokens at today's rows, still show what the providers
 * charged Kade), tokenValue is 0 (so every "charged" readout and the balance stay truthful with no
 * filter), kadeFactor is 0 and kadeUncharged names the reason.
 * @param {string} reason
 */
function unchargedPricing(reason) {
  return { getMultiplier: () => 0, getCacheMultiplier: () => 0, factor: 0, uncharged: String(reason || 'failed') };
}

/** KADE_UNCHARGED_FAILED_TURNS=0 charges recursion-limit turns again (the rollback switch). */
function unchargedFailedTurnsOn(env = process.env) {
  return String((env && env.KADE_UNCHARGED_FAILED_TURNS) ?? '') !== '0';
}

/** How many failed turns a payer may have uncharged in 24 hours (KADE_UNCHARGED_PER_DAY, default 3). */
function unchargedPerDay(env = process.env) {
  const raw = String((env && env.KADE_UNCHARGED_PER_DAY) ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 ? n : 3;
}

/** A text part this long means the person already got an answer before the cut. */
const UNCHARGED_TEXT_MAX = 200;

/**
 * Oct 20 2026 review: the recursion limit is not only something that happens TO a person. An
 * agent's recursion_limit is the creator's setting (every account may create agents), so an agent
 * set to 2 steps that answers in round 1 and then calls a tool would make every turn free. A failed
 * turn is uncharged only when all of these hold:
 *   - KADE_UNCHARGED_FAILED_TURNS is not '0';
 *   - the agent ran at the platform's own limit or above (its resolved recursion_limit is at least
 *     what an agent with no setting gets), so a lowered limit is charged normally;
 *   - no answer streamed before the cut (no text part over UNCHARGED_TEXT_MAX characters), as in
 *     Part 142's "only when no text was produced";
 *   - the payer has had fewer than unchargedPerDay() uncharged turns in the last 24 hours.
 * Anything that cannot be checked (a missing limit, a failed count) charges normally. Never throws.
 * @param {{ agentLimit?: number, platformLimit?: number, contentParts?: object[],
 *   countRecent?: () => Promise<number>, env?: object }} opts
 * @returns {Promise<{ uncharged: boolean, why: string, recent?: number }>}
 */
async function failedTurnUncharged({ agentLimit, platformLimit, contentParts = [], countRecent, env = process.env } = {}) {
  if (!unchargedFailedTurnsOn(env)) return { uncharged: false, why: 'switched_off' };
  const agent = Number(agentLimit);
  const platform = Number(platformLimit);
  if (!Number.isFinite(agent) || !Number.isFinite(platform) || platform <= 0 || agent < platform) {
    return { uncharged: false, why: 'agent_limit_below_platform' };
  }
  const answered = (Array.isArray(contentParts) ? contentParts : []).some(
    (p) => p && p.type === 'text' && String(p.text ?? '').trim().length > UNCHARGED_TEXT_MAX,
  );
  if (answered) return { uncharged: false, why: 'answer_streamed' };
  const cap = unchargedPerDay(env);
  let recent;
  try {
    recent = Number(await countRecent());
  } catch (_) {
    return { uncharged: false, why: 'count_failed' };
  }
  if (!Number.isFinite(recent)) return { uncharged: false, why: 'count_failed' };
  if (recent >= cap) return { uncharged: false, why: 'daily_cap', recent };
  return { uncharged: true, why: 'recursion_limit', recent };
}

/**
 * How many distinct turns (messageIds) a payer had recorded uncharged in the 24 hours before `now`.
 * @param {string | object} user the payer's id
 * @param {{ Transaction?: { distinct: Function }, now?: Date }} [opts]
 */
async function countUnchargedRecent(user, { Transaction, now = new Date() } = {}) {
  if (!user) return 0;
  let T = Transaction;
  if (!T) {
    const mongoose = require('mongoose');
    T = mongoose.models.Transaction || mongoose.model('Transaction');
  }
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const ids = await T.distinct('messageId', {
    user,
    kadeUncharged: { $exists: true },
    createdAt: { $gte: since },
  });
  return Array.isArray(ids) ? ids.filter((id) => id != null).length : 0;
}

/**
 * Oct 20 2026 ("include the old chat paths"): the legacy db.spendTokens / spendStructuredTokens
 * paths priced every row at the platform factor whoever paid. This writes the same rows
 * (prompt, completion; structured prompt rows with cache splits) through prepareTokenSpend and
 * bulkWriteTransactions at chargePricing(account), so a Family pack account pays factor 1 and every
 * row carries kadeFactor. Balance and transactions config ride on txData exactly as spendTokens
 * reads them (no balance.enabled = rows only). Never throws.
 * @param {object | string | null} account the payer (a full user, PAYER_FIELDS at least)
 * @param {object} txData { user, model, context, conversationId, messageId, balance, transactions, endpointTokenConfig }
 * @param {{ promptTokens?: number | { input?: number, write?: number, read?: number }, completionTokens?: number }} tokenUsage
 * @param {{ db: object, structured?: boolean, pricing?: object, updateBalance?: Function, api?: object }} opts
 */
async function spendTokensAs(account, txData, tokenUsage, opts = {}) {
  const { db, structured = false } = opts;
  try {
    const api = opts.api || require('@librechat/api');
    const pricing = opts.pricing || chargePricing(account, db);
    const data = {
      user: String(txData.user),
      model: txData.model,
      context: txData.context || 'message',
      messageId: txData.messageId,
      conversationId: txData.conversationId,
      endpointTokenConfig: txData.endpointTokenConfig ?? undefined,
      balance: txData.balance,
      transactions: txData.transactions,
      ...(txData.valueKey ? { valueKey: txData.valueKey } : {}),
    };
    const docs = structured
      ? api.prepareStructuredTokenSpend(data, tokenUsage, pricing)
      : api.prepareTokenSpend(data, tokenUsage, pricing);
    await api.bulkWriteTransactions(
      { user: data.user, docs },
      { insertMany: db.bulkInsertTransactions, updateBalance: opts.updateBalance || db.updateBalance },
    );
  } catch (err) {
    try {
      require('@librechat/data-schemas').logger.error('[kadeRealCost #spendTokensAs]', err);
    } catch (_) {
      /* noop */
    }
  }
}

module.exports = {
  FACTOR_SINCE,
  CREDIT_USD,
  SPEND_TYPES,
  platformFactor,
  isAdminRole,
  PAYER_FIELDS,
  familyAtCost,
  payerTier,
  payerFromReq,
  setFamilyPackRuleForTests,
  userPriceFactor,
  extraChargeUSD,
  realPricing,
  chargePricing,
  unchargedPricing,
  unchargedFailedTurnsOn,
  unchargedPerDay,
  UNCHARGED_TEXT_MAX,
  failedTurnUncharged,
  countUnchargedRecent,
  spendTokensAs,
  openRouterCost,
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
