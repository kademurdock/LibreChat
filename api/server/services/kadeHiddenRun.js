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
 *
 * Nov 13 2026 (sweep): every hidden run is also marked req.kadeBackground = true. Nobody is
 * waiting on a character's day, a reach-out draft, a task or any other server-built turn, so the
 * model request carries kade_background: true (packages/api endpoints/custom/initialize.ts) and
 * the gateway sends a MiMo Pro run to the cheap host instead of the fast one. The gateway takes
 * the mark off before any host sees it. KADE_SEND_BACKGROUND=0 stops the mark being sent.
 *
 * Nov 14 2026 (her words: "Change the lyric desk etc to it too, whatever benefits from better writing
 * than Mimo"). One more header, honoured only with the key:
 *   x-kade-claude-lane: speak-first   the run is ONE message a character sends on its own (a friend
 *                             text, a research or errand write-up, a reach-out), not a background
 *                             task's many rounds. req.kadeClaudeLane is set, the model
 *                             request carries kade_claude_lane: 'speak-first' (endpoints/custom/
 *                             initialize.ts), and the gateway may write it with Claude for a verified
 *                             adult (reframe-proxy claude-route.js), falling back to MiMo. Any other
 *                             value is ignored. KADE_SEND_CLAUDE_LANE=0 stops the mark being sent.
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

/**
 * Nov 14 2026: TEST SEATS NEVER REACH CLAUDE. The daily character battery (the bridge's
 * battery.js, on the vischeck seat at 07:00Z) and the evalclean seat are typed adult, so since
 * Claude came on (gateway KADE_CLAUDE_CHAT=1) every probe went to Claude Opus and wrote a fresh
 * prompt cache: about $0.23 a probe, $1.67 in the first two minutes of the Nov 14 run. Their turns
 * are now marked background (req.kadeBackground), which is all the gateway needs to keep them on
 * MiMo's cheap host; nothing else about the turn changes (req.kadeHiddenRun stays unset, so memory,
 * nudges and the soul state behave exactly as before). KADE_CLAUDE_EXCLUDE_USERS is a comma list of
 * account ids; empty or unset means nobody.
 */
function excludedFromClaude(req, env = process.env) {
  const list = String((env && env.KADE_CLAUDE_EXCLUDE_USERS) || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const id = req && req.user && (req.user.id || req.user._id);
  return list.length > 0 && id != null && list.includes(String(id));
}

/** Express middleware for the agent chat router. */
function markHiddenRun(req, _res, next) {
  try {
    if (excludedFromClaude(req)) {
      req.kadeBackground = true;
    }
    if (!keyMatches(req.get && req.get('x-kade-hidden-run'))) {
      return next();
    }
    req.kadeHiddenRun = true;
    req.kadeBackground = true;
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
    if (req.get('x-kade-claude-lane') === 'speak-first') {
      req.kadeClaudeLane = 'speak-first';
    }
  } catch (_) {
    /* a hidden-run hiccup leaves the turn an ordinary turn */
  }
  return next();
}

/** Headers for a loopback call that should run hidden. `oneMessage`: the run is a single message
 *  a character sends on its own (the speak-first writing lane). */
function hiddenRunHeaders({ platformPaid = false, steps, oneMessage = false } = {}) {
  return {
    'x-kade-hidden-run': KEY,
    ...(platformPaid ? { 'x-kade-platform-paid': '1' } : {}),
    ...(steps ? { 'x-kade-steps': String(steps) } : {}),
    ...(oneMessage === true ? { 'x-kade-claude-lane': 'speak-first' } : {}),
  };
}

module.exports = { markHiddenRun, hiddenRunHeaders, ownerId, excludedFromClaude };
