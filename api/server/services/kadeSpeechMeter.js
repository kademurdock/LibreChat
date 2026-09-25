'use strict';
/**
 * KADE Sep 25 2026 (Part 291) — the Inworld speech meter on /usage-dashboard and the iPhone Admin
 * screen (GET /api/kade/usage -> inworld).
 *
 * Her plan, from her receipts: $25 a month of credit, and inworld-tts-2 at $10 per million
 * characters, so about 2,500,000 characters a month are included (not the 25 million the July
 * notes carried); past that, overage is $10 per million. Speech stays free to users; this meter
 * only watches her credit.
 *
 *   KADE_INWORLD_INCLUDED_CHARS  characters the monthly credit covers (default 2500000)
 *   KADE_INWORLD_USD_PER_M       overage dollars per million characters (default 10)
 *
 * Read per call, so a Railway variable change needs no code change. Keep monthChars and
 * includedChars: the iPhone reads those names. What it counts: site and app speech logged to
 * kadeusage (Fish voices included). Phone-call speech on the bridge is not counted yet.
 *
 * No '~' requires, so node --test loads it.
 */

const DEFAULT_INCLUDED_CHARS = 2500000;
const DEFAULT_USD_PER_M = 10;

function positive(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {number} monthChars characters logged this calendar month
 * @param {Record<string, string | undefined>} [env]
 */
function inworldMeter(monthChars, env = process.env) {
  const e = env || {};
  const includedChars = Math.round(positive(e.KADE_INWORLD_INCLUDED_CHARS, DEFAULT_INCLUDED_CHARS));
  const overagePerMillionUSD = positive(e.KADE_INWORLD_USD_PER_M, DEFAULT_USD_PER_M);
  const used = Math.max(0, Number(monthChars) || 0);
  const overageChars = Math.max(0, used - includedChars);
  return {
    monthChars: used,
    includedChars,
    overagePerMillionUSD,
    overageChars,
    overageUSD: Math.round(((overageChars / 1e6) * overagePerMillionUSD + Number.EPSILON) * 100) / 100,
    phoneCallsCounted: false,
  };
}

module.exports = { DEFAULT_INCLUDED_CHARS, DEFAULT_USD_PER_M, inworldMeter };
