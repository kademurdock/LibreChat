/**
 * WHO IS ASKING, AND ON WHICH LANE, for the private-things tools (Nov 11 2026, cards 8 and 9).
 *
 * A small adapter so kade_known and kade_recall compile and run alone. The safety lane (card 3)
 * builds one helper, laneTrust(req), that answers 'signed-in' | 'paired-phone' | 'phone'. When a
 * module exporting laneTrust is present it decides. Until then the answer is today's rule, the
 * same one kade_studio uses (services/kadeStudio.js actor): a turn the voice bridge sends on
 * someone's behalf is a phone call unless KADE_STUDIO_APP_VOICE=1 and the bridge says the
 * caller is signed in; a folded call history is a phone call; everything else is the signed-in
 * app or website.
 *
 * Pure: no database, no wait. No '~' requires, so node --test loads it.
 */
'use strict';

const LANES = new Set(['signed-in', 'paired-phone', 'phone']);
/* Where the safety lane's helper may live. The first that exports laneTrust wins. */
const CANDIDATES = ['./kadeLaneTrust', './kadePhoneLane', './kadeLaneSafety', './kadeSpendGate'];

/* For unit tests only: a stand-in laneTrust. Never set in the running server. */
const seam = { laneTrust: null };

function realLaneTrust() {
  for (const mod of CANDIDATES) {
    try {
      const m = require(mod);
      if (m && typeof m.laneTrust === 'function') return m.laneTrust;
    } catch (_) {
      /* not built yet */
    }
  }
  return null;
}

function fallbackLane(req, env = process.env) {
  const body = (req && req.body) || {};
  const behalf = req && req.kadeOnBehalfOf;
  if (behalf && behalf.id) {
    const appVoice =
      String((env && env.KADE_STUDIO_APP_VOICE) ?? '') === '1' &&
      String((req.user && req.user.role) || '').toUpperCase() === 'ADMIN' &&
      body.kadeCallerSignedIn === true;
    return appVoice ? 'signed-in' : 'phone';
  }
  try {
    if (require('./kadeSpendGate').latestWords(body.text).folded) return 'phone';
  } catch (_) {
    /* cannot tell: treat as a call, the safe side */
    return 'phone';
  }
  return 'signed-in';
}

/** 'signed-in' | 'paired-phone' | 'phone'. Anything unexpected from a helper reads as 'phone'. */
function laneOf(req, env = process.env) {
  const helper = seam.laneTrust || realLaneTrust();
  if (helper) {
    try {
      const v = helper(req);
      return LANES.has(v) ? v : 'phone';
    } catch (_) {
      return 'phone';
    }
  }
  return fallbackLane(req, env);
}

/**
 * The person this turn is for.
 * @returns {{ ok: true, userId: string, lane: string } | { ok: false, why: 'unavailable'|'hidden'|'unknown-caller' }}
 */
function actorOf(req, env = process.env) {
  if (!req || !req.user || !req.user.id) return { ok: false, why: 'unavailable' };
  if (req.kadeHiddenRun === true) return { ok: false, why: 'hidden' };
  if (req.kadeOnBehalfOfUnresolved === true) return { ok: false, why: 'unknown-caller' };
  const body = req.body || {};
  const behalf = req.kadeOnBehalfOf;
  if (behalf && behalf.id) return { ok: true, userId: String(behalf.id), lane: laneOf(req, env) };
  if (body.kadeOnBehalfOf) return { ok: false, why: 'unknown-caller' };
  return { ok: true, userId: String(req.user.id), lane: laneOf(req, env) };
}

module.exports = { laneOf, actorOf, fallbackLane, LANES, __seam: seam };
