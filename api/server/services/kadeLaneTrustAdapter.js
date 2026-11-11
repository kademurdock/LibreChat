/**
 * WHO IS ASKING, AND ON WHICH LANE, for the private-things tools (Nov 11 2026, cards 8 and 9).
 *
 * kade_known and kade_recall ask this file, and it asks the safety lane's laneTrust(req)
 * (services/kadeLaneTrust.js, card 3), which answers 'signed-in' | 'paired-phone' | 'phone':
 * text chat in the app or website and verified signed-in app voice (the bridge's signed lane
 * pass, services/kadeVoiceLane.js) are signed in; a phone paired by a spoken code is
 * 'paired-phone'; every other voice turn is a phone call. Both tools act only when signed in.
 *
 * Pure: no database, no wait (a pairing lookup, when there is one, was already made by the
 * ledger wrapper before the tool ran). No '~' requires, so node --test loads it.
 */
'use strict';

const LANES = new Set(['signed-in', 'paired-phone', 'phone']);

/* For unit tests only: a stand-in laneTrust. Never set in the running server. */
const seam = { laneTrust: null };

/** 'signed-in' | 'paired-phone' | 'phone'. Anything unexpected reads as 'phone', the safe side. */
function laneOf(req, env = process.env) {
  try {
    const helper = seam.laneTrust || require('./kadeLaneTrust').laneTrust;
    const v = helper(req, env);
    return LANES.has(v) ? v : 'phone';
  } catch (_) {
    return 'phone';
  }
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

module.exports = { laneOf, actorOf, LANES, __seam: seam };
