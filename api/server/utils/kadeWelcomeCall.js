/* ----------------------------------------------------------------------------
 * WELCOME CALL FOR PHONE-ONLY ACCOUNTS (Oct 29 2026).
 *
 * Kade: "my friend David registered with just his phone under Toker, but his
 * phone can't get a temp password from resend email so he prob hasn't ever
 * been able to log in." An account approved from a phone number alone is filed
 * under a placeholder address (kadeLoginId.js) that can never receive mail,
 * so its temporary password used to reach only Kade's screen.
 *
 * Now the platform calls them: the bridge (POST /account-welcome-call,
 * BRIDGE_SECRET, see the bridge's account-welcome-call.js) reads their sign-in
 * and the temporary password aloud, slowly and twice, spelled out. A
 * voicemail never hears the password: it gets "we'll call you back", and the
 * lookup says so, so Kade's page keeps the card and offers "Call again".
 *
 * checkWelcomeCall asks the bridge the same question with dryRun:true and
 * places nothing, so "Call again" can make sure the call will go out before
 * it replaces anyone's password.
 *
 * Everything here is fail-soft: a call that cannot be placed leaves the
 * account made and the password in Kade's message, and she is told plainly to
 * read it to them. Nothing here logs the password or the full phone number.
 * -------------------------------------------------------------------------- */
const { normalizePhone } = require('~/server/utils/kadeLoginId');

function bridgeBase() {
  return (process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app').replace(/\/$/, '');
}

async function withTimeout(ms, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Why the bridge said no, in words for Kade. */
async function refusalReason(r) {
  let reason = '';
  try {
    reason = String(((await r.json()) || {}).reason || '');
  } catch {
    reason = '';
  }
  if (r.status === 429) {
    if (reason === 'gap') {
      return 'that number was called in the last minute or two';
    }
    if (reason === 'number-day') {
      return 'that number has already had 3 calls today';
    }
    if (reason === 'platform-day') {
      return 'the phone line has made all the calls it is allowed today';
    }
    return 'that number was called very recently, or too many times today';
  }
  if (r.status === 404) {
    return 'the phone line has not been updated for welcome calls yet';
  }
  if (r.status === 503) {
    return 'the phone line is not set up to make calls';
  }
  return `the phone line answered ${r.status}`;
}

/**
 * One request to the bridge. `dryRun` checks without calling.
 * @returns {Promise<{status:'placed'|'ready', sid?:string|null} | {status:'failed'|'off', reason:string}>}
 */
async function askBridge({ phone, name, password }, dryRun) {
  if (process.env.KADE_WELCOME_CALL === '0') {
    return { status: 'off', reason: 'welcome calls are switched off' };
  }
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) {
    return { status: 'failed', reason: 'the bridge secret is missing' };
  }
  const digits = normalizePhone(phone);
  if (!digits) {
    return { status: 'failed', reason: 'there is no phone number to call' };
  }
  const payload = { to: `+1${digits}`, name: String(name || ''), password };
  if (dryRun) {
    payload.dryRun = true;
  }
  try {
    return await withTimeout(dryRun ? 8000 : 15000, async (signal) => {
      const r = await fetch(`${bridgeBase()}/account-welcome-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-secret': secret },
        body: JSON.stringify(payload),
        signal,
      });
      if (r.ok) {
        const out = await r.json().catch(() => ({}));
        if (dryRun) {
          /* An old bridge ignores dryRun and really calls; only a bridge that
           * says dryRun back has checked without calling. */
          return out && out.dryRun === true
            ? { status: 'ready' }
            : { status: 'failed', reason: 'the phone line has not been updated for welcome calls yet' };
        }
        return { status: 'placed', sid: out && out.sid ? String(out.sid) : null };
      }
      return { status: 'failed', reason: await refusalReason(r) };
    });
  } catch (e) {
    return {
      status: 'failed',
      reason: e && e.name === 'AbortError' ? 'the phone line took too long' : 'the phone line could not be reached',
    };
  }
}

/** Asks the bridge to place the call. Never throws. */
function placeWelcomeCall(call) {
  return askBridge(call, false);
}

/**
 * Asks the bridge whether this call would go out right now (spacing, daily
 * caps, Twilio set up) without placing it. {status:'ready'} or a refusal.
 */
function checkWelcomeCall(call) {
  return askBridge(call, true);
}

/** How the call went, from the bridge (Twilio's own words). null when unknown. */
async function welcomeCallOutcome(sid) {
  const secret = process.env.BRIDGE_SECRET;
  if (!secret || !/^CA[0-9a-f]{32}$/i.test(String(sid || ''))) {
    return null;
  }
  try {
    return await withTimeout(5000, async (signal) => {
      const r = await fetch(`${bridgeBase()}/account-welcome-call/${sid}`, {
        headers: { 'x-bridge-secret': secret },
        signal,
      });
      if (!r.ok) {
        return null;
      }
      const out = await r.json();
      return {
        status: String(out.status || ''),
        duration: Number(out.duration || 0),
        answeredBy: out.answeredBy || null,
        played: out.played || null,
      };
    });
  } catch {
    return null;
  }
}

/** Twilio statuses that will not change any more. */
const FINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

/** A person must stay on this long for the call to count as heard. */
const HEARD_SECONDS = 20;

/**
 * Twilio's answer as one word:
 * 'answered' (a person, 20 s or more) | 'short' | 'voicemail' (the short
 * message, no password) | 'voicemail-full' | 'lost' (the bridge lost the
 * script) | 'no-answer' | 'busy' | 'failed' | 'going' | '' (unknown).
 */
function callResult(outcome) {
  if (!outcome || !outcome.status) {
    return '';
  }
  const { status, duration, answeredBy, played } = outcome;
  const machine = /^(machine|fax)/.test(String(answeredBy || ''));
  if (status === 'completed') {
    if (played === 'voicemail' || (machine && played !== 'full')) {
      return 'voicemail';
    }
    if (machine) {
      return 'voicemail-full';
    }
    if (played === 'lost') {
      return 'lost';
    }
    return Number(duration || 0) >= HEARD_SECONDS ? 'answered' : 'short';
  }
  if (status === 'no-answer' || status === 'busy') {
    return status;
  }
  if (status === 'failed' || status === 'canceled') {
    return 'failed';
  }
  return 'going';
}

/**
 * Whether Kade can stop thinking about this account: a person heard the call
 * for 20 seconds or more, or she said they are already signed in. Everything
 * else (voicemail, no answer, a short call, a failed or switched-off call, a
 * call nobody has heard back about) keeps the card in her default view.
 */
function isSettled({ welcomeCallStatus, welcomeCallResult }) {
  return (
    welcomeCallStatus === 'not-needed' ||
    (welcomeCallStatus === 'placed' && welcomeCallResult === 'answered')
  );
}

/** One plain sentence for Kade's page about how the call went. */
function describeOutcome(outcome) {
  const result = callResult(outcome);
  const duration = Number((outcome && outcome.duration) || 0);
  switch (result) {
    case 'answered':
      return `They answered and the call ran ${duration} seconds.`;
    case 'short':
      return `The call was answered but ended after ${duration} seconds, probably before the password. Press "Call again", or read it to them.`;
    case 'voicemail':
      return 'The call reached their voicemail. It left only a short message saying we would call back, with no password. Press "Call again", or read it to them.';
    case 'voicemail-full':
      return `The call went to their voicemail and left the whole message, password included (${duration} seconds).`;
    case 'lost':
      return 'They answered, but the phone line restarted before it could read the password. Press "Call again".';
    case 'no-answer':
      return 'Nobody answered the call. Press "Call again" later, or read it to them.';
    case 'busy':
      return 'Their line was busy. Press "Call again" later.';
    case 'failed':
      return 'The call did not go through. Check the number, or read it to them.';
    case 'going':
      return 'The call is still going.';
    default:
      return '';
  }
}

module.exports = {
  placeWelcomeCall,
  checkWelcomeCall,
  welcomeCallOutcome,
  callResult,
  isSettled,
  describeOutcome,
  FINAL,
  HEARD_SECONDS,
};
