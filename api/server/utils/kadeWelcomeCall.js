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
 * and the temporary password aloud, slowly and twice, spelled out. Everything
 * here is fail-soft: a call that cannot be placed leaves the account made and
 * the password in Kade's message, and she is told plainly to read it to them.
 *
 * Nothing here logs the password or the full phone number.
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

/**
 * Asks the bridge to place the call.
 * @returns {Promise<{status:'placed', sid:string|null} | {status:'failed'|'off', reason:string}>}
 */
async function placeWelcomeCall({ phone, name, password }) {
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
  try {
    return await withTimeout(15000, async (signal) => {
      const r = await fetch(`${bridgeBase()}/account-welcome-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-secret': secret },
        body: JSON.stringify({ to: `+1${digits}`, name: String(name || ''), password }),
        signal,
      });
      if (r.ok) {
        const out = await r.json().catch(() => ({}));
        return { status: 'placed', sid: out && out.sid ? String(out.sid) : null };
      }
      const reason =
        r.status === 429
          ? 'that number was called very recently, or too many times today'
          : r.status === 404
            ? 'the phone line has not been updated for welcome calls yet'
            : `the phone line answered ${r.status}`;
      return { status: 'failed', reason };
    });
  } catch (e) {
    return { status: 'failed', reason: e && e.name === 'AbortError' ? 'the phone line took too long' : 'the phone line could not be reached' };
  }
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
      return { status: String(out.status || ''), duration: Number(out.duration || 0), answeredBy: out.answeredBy || null };
    });
  } catch {
    return null;
  }
}

/** Twilio statuses that will not change any more. */
const FINAL = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];

/** One plain sentence for Kade's page about how the call went. */
function describeOutcome(outcome) {
  if (!outcome || !outcome.status) {
    return '';
  }
  const { status, duration, answeredBy } = outcome;
  if (status === 'completed') {
    if (answeredBy && String(answeredBy).startsWith('machine')) {
      return `The call went to their voicemail and left the whole message (${duration} seconds).`;
    }
    if (duration < 20) {
      return `The call was answered but ended after ${duration} seconds, probably before the password. Call again, or read it to them.`;
    }
    return `They answered and the call ran ${duration} seconds.`;
  }
  if (status === 'no-answer') {
    return 'Nobody answered the call. Call again later, or read it to them.';
  }
  if (status === 'busy') {
    return 'Their line was busy. Call again later.';
  }
  if (status === 'failed' || status === 'canceled') {
    return 'The call did not go through. Check the number, or read it to them.';
  }
  return 'The call is still going.';
}

module.exports = { placeWelcomeCall, welcomeCallOutcome, describeOutcome, FINAL };
