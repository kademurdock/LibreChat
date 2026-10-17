/**
 * KADE HIDDEN RUNS (Oct 16 2026). A server-built turn of a character, run on the
 * person's OWN seat so their memory and the character's soul state load exactly
 * as in a real chat, but marked so it leaves no trace of its own:
 *
 *   - the keeper never runs (the platform note that started the turn is not
 *     something the person said, so nothing from it may become a memory),
 *   - waiting notes are not picked up (services/kadeNudgeTurn.js already
 *     checks req.kadeHiddenRun),
 *   - the soul state is read but never written.
 *
 * The mark is a header carrying a key that exists only inside this process,
 * made fresh at boot. Only kadeCharacterTurn.js, calling the site over
 * loopback, can present it; nothing outside the process can forge it, so no
 * environment secret is needed and none can leak.
 *
 * Two more headers are honoured ONLY together with that key:
 *   x-kade-platform-paid: 1   the turn is the platform's expense (a character
 *                             texting first, unasked); usage is booked to the
 *                             owner's seat and the person's balance is never
 *                             checked or drawn.
 *   x-kade-steps: N           a bigger step budget for background work, in tool
 *                             rounds (1..80), still under the yaml maximum.
 */
'use strict';

const crypto = require('crypto');

const KEY = crypto.randomBytes(32).toString('hex');
const OWNER_ID_DEFAULT = '6a3cba4d0b0afa92194e42f7';

function ownerId() {
  return process.env.KADE_OWNER_USER_ID || OWNER_ID_DEFAULT;
}

function keyMatches(value) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Express middleware for the agent chat router. */
function markHiddenRun(req, _res, next) {
  try {
    if (!keyMatches(req.get && req.get('x-kade-hidden-run'))) {
      return next();
    }
    req.kadeHiddenRun = true;
    if (req.get('x-kade-platform-paid') === '1') {
      req.kadePlatformPaid = true;
      if (req.user && String(req.user.id) !== ownerId()) {
        req.kadeBillTo = ownerId();
      }
    }
    const steps = parseInt(req.get('x-kade-steps') || '', 10);
    if (Number.isFinite(steps) && steps > 0) {
      req.kadeStepBudget = Math.min(80, steps);
    }
  } catch (_) {
    /* a hidden-run hiccup leaves the turn an ordinary turn */
  }
  return next();
}

/** Headers for a loopback call that should run hidden. */
function hiddenRunHeaders({ platformPaid = false, steps } = {}) {
  return {
    'x-kade-hidden-run': KEY,
    ...(platformPaid ? { 'x-kade-platform-paid': '1' } : {}),
    ...(steps ? { 'x-kade-steps': String(steps) } : {}),
  };
}

module.exports = { markHiddenRun, hiddenRunHeaders, ownerId };
