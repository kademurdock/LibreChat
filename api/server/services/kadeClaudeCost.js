'use strict';
/**
 * KADE Nov 14 2026: WHAT A CHARACTER'S OWN MESSAGE REALLY COST WHEN CLAUDE WROTE IT.
 *
 * Kade said yes to characters' own texts (a friend text, a reach-out) going to Claude Opus 5.5 on her
 * credit, about 20 cents each. The gateway (reframe-proxy claude-route.js) hands every Claude turn back
 * to the website as MiMo-equivalent usage, so nobody is charged more than MiMo would have cost: the
 * transactions rows for that turn carry MiMo-sized token counts at the MiMo price. Reach-out's money
 * ceiling (services/kadeReachOut.js, 25 cents a day) read only those rows, so on Claude it saw about
 * a cent and a half where her credit paid about 20 to 30 cents, and would never have stopped reach-out
 * before its 10 messages a day (the Nov 14 money review: roughly $60 to $90 a month).
 *
 * The real numbers ride along: the gateway puts them in usage.kade_claude (real_cost: what OpenRouter
 * reports, plus the upstream charge on her own Anthropic key), and LangChain keeps the raw usage in the
 * model message's response_metadata.usage, which the ModelEndHandler sees (checked against
 * @librechat/agents 3.2.46 with a stand-in host on Nov 14). So:
 *
 *   costOf(output)     the ModelEndHandler reads { real, billed } for one model call, or null when the
 *                      call was not written by Claude (a MiMo answer, a fallback): nothing changes then.
 *   extraUsd(usage)    over one turn's collected usage: what Claude cost above what the rows already
 *                      count (real minus the MiMo-equivalent `cost`, never below zero).
 *   record(...)        a hidden run (a character's own message, services/kadeHiddenRun.js) adds that
 *                      extra to one small row per conversation, kept 30 days. Nothing else is written,
 *                      no words, no person: the throwaway conversation's id, dollars and a call count.
 *   extraUsdFor(id)    reach-out reads it back beside the transactions rows (kadeReachOut turnCents).
 *
 * Billing is untouched: what anyone is charged still comes only from the transactions rows.
 * KADE_CLAUDE_COST_RECORD=0 stops the rows being written (reach-out then counts as before).
 *
 * No '~' requires at the top, so node --test loads it.
 */

const COLL = 'kadeclaudecosts';
const KEEP_MS = 30 * 86400000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * One model call's Claude cost, from the message the model ended with. Null when it carries no
 * gateway note (MiMo answered, or the gateway is older), or the note has no usable real cost.
 * @returns {{ real: number, billed: number } | null}  dollars
 */
function costOf(output) {
  try {
    const usage = output && output.response_metadata && output.response_metadata.usage;
    const note = usage && usage.kade_claude;
    if (!note || typeof note !== 'object') return null;
    const real = num(note.real_cost);
    if (real == null || real < 0) return null;
    const billed = num(usage.cost);
    return { real, billed: billed != null && billed > 0 ? billed : 0 };
  } catch (_) {
    return null;
  }
}

/** What Claude cost above the rows' MiMo-equivalent price, over one turn's collected usage (dollars). */
function extraUsd(collectedUsage) {
  if (!Array.isArray(collectedUsage)) return 0;
  let extra = 0;
  for (const u of collectedUsage) {
    const c = u && u.kade_claude_cost;
    if (!c || num(c.real) == null) continue;
    extra += Math.max(0, c.real - (num(c.billed) || 0));
  }
  return extra;
}

/** How many of a turn's model calls Claude wrote. */
function claudeCalls(collectedUsage) {
  return Array.isArray(collectedUsage)
    ? collectedUsage.filter((u) => u && u.kade_claude_cost).length
    : 0;
}

const seam = { coll: null, logger: null, indexed: false };

/** A warning with ids and dollars only; never throws (node --test has no logger unless one is given). */
function warn(message) {
  try {
    (seam.logger || require('@librechat/data-schemas').logger).warn(message);
  } catch (_) {
    /* no logger here */
  }
}
function coll() {
  if (seam.coll) return seam.coll(COLL);
  return require('mongoose').connection.collection(COLL);
}

/* The 30-day clean-up: one TTL index on expireAt, made once per process, tried again after a failure. */
async function ensureIndex() {
  if (seam.indexed) return;
  seam.indexed = true;
  try {
    const c = coll();
    if (typeof c.createIndex === 'function') await c.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  } catch (_) {
    seam.indexed = false;
  }
}

/** Is recording switched on? Read per call. */
function recording(env = process.env) {
  return String((env && env.KADE_CLAUDE_COST_RECORD) ?? '').trim() !== '0';
}

/**
 * Add one turn's Claude extra to its conversation's row. Only for a hidden run (the caller checks);
 * returns the dollars added (0 when Claude wrote none of it). Never throws.
 */
async function record({ conversationId, collectedUsage, now = new Date(), env = process.env }) {
  let extra = 0;
  try {
    if (!recording(env) || !conversationId) return 0;
    extra = extraUsd(collectedUsage);
    const calls = claudeCalls(collectedUsage);
    if (!(extra > 0) || !calls) return 0;
    await ensureIndex();
    await coll().findOneAndUpdate(
      { _id: String(conversationId) },
      {
        $inc: { usd: extra, calls },
        $set: { at: now, expireAt: new Date(now.getTime() + KEEP_MS) },
      },
      { upsert: true },
    );
    return extra;
  } catch (e) {
    /* Reach-out then counts this turn at the billed price only: say so, ids and dollars only. */
    warn(
      `[kadeClaudeCost] Claude cost not recorded for ${String(conversationId || '').slice(0, 8)} ` +
        `($${Number(extra || 0).toFixed(4)}): ${e && e.message}`,
    );
    return 0;
  }
}

/**
 * The agents client's hook (controllers/agents/client.js recordCollectedUsage, after billing): only a hidden run's
 * message turn records (a character's own message; never a person's chat, a title or an abort). Never throws.
 */
async function recordForTurn({ req, context, conversationId, collectedUsage, env = process.env }) {
  if (!req || req.kadeHiddenRun !== true || context !== 'message') return 0;
  return record({ conversationId, collectedUsage, env });
}

/** The Claude extra recorded for one conversation (dollars; 0 when none). */
async function extraUsdFor(conversationId) {
  if (!conversationId) return 0;
  const row = await coll().findOne({ _id: String(conversationId) });
  const usd = row && num(row.usd);
  return usd != null && usd > 0 ? usd : 0;
}

module.exports = {
  costOf,
  extraUsd,
  claudeCalls,
  record,
  recordForTurn,
  extraUsdFor,
  recording,
  COLL,
  _seam: seam,
};
