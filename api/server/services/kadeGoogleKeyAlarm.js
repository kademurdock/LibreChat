'use strict';
/**
 * KADE Sep 26 2026 (Part 295) — THE GOOGLE KEY ALARM.
 *
 * One AI Studio key on this service (KADE_EMBED_GEMINI_KEY) feeds memory embeddings
 * (models/kadeDiary.js), Lyria songs (routes/kadeSoundBooth.js) and the lyric transcriber
 * (packages/api music/lyrics.ts). On Aug 28 its prepaid credit ran out: every embedding answered
 * 429, memory recall went blind platform-wide, and for days the only trace was a warning in the
 * log. Now a Google refusal that looks like the key itself (429 RESOURCE_EXHAUSTED, a billing or
 * prepayment error, a 403 PERMISSION_DENIED, a 400 API_KEY_INVALID / API_KEY_EXPIRED for a
 * deleted, rotated or expired key) logs one clear line every time and tells Kade at most once
 * every few hours (KADE_GOOGLE_KEY_ALERT_HOURS, default 4) through the owner-alert lane
 * (kadeOwnerAlerts.alertOwner: a chat nudge plus a bridge /notify adminAlert push; mute
 * 'kade-google-key-alert' in notify-prefs). A per-second or per-minute rate limit is only logged:
 * it clears itself. One throttle per key name: lanes that share a key share it, so one empty
 * balance is one alert, not three, while a separate KADE_LYRIA_KEY or GEMINI_API_KEY is heard on
 * its own. The throttle lives in memory, so a redeploy can alert again once.
 *
 * Search the logs for: [google-key-alarm]
 *
 * Never prints the key: nothing here reads the request URL (kadeDiary puts the key in it) or
 * headers, only the response status and Google's own error text, with anything shaped like a key
 * masked. No '~' requires at the top, so node --test loads it.
 */

const TAG = '[google-key-alarm]';
const DEFAULT_HOURS = 4;
/** When Kade was last told, per key NAME (never the value). */
const state = { lastAlertAt: new Map() };

function alertHours(env = process.env) {
  const raw = Number(env && env.KADE_GOOGLE_KEY_ALERT_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOURS;
}

/** Google's key-shaped strings (AIza...) and any key= query value, masked. */
function scrub(text) {
  return String(text || '')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[key]')
    .replace(/([?&]key=)[^&\s"']+/gi, '$1[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/**
 * Part 295 review: Google's ordinary rate-limit answer says "You exceeded your current quota,
 * please check your plan and billing details", so the word "billing" alone is not a money problem.
 * That boilerplate is taken out before the money words are looked for.
 */
const RATE_LIMIT_BOILERPLATE = /please check your plan and billing details\.?/gi;
const MONEY = /billing|prepa(y|id)|credit|payment|insufficient.?funds|out of funds/i;
/** A deleted, rotated or expired key: Google answers 400 INVALID_ARGUMENT with one of these. */
const INVALID_KEY_REASONS = ['API_KEY_INVALID', 'API_KEY_EXPIRED'];
const INVALID_KEY_WORDS = /API key (not valid|expired)|API_KEY_(INVALID|EXPIRED)/i;
/** Quota windows that refill on their own within minutes: a burst, not the key running dry. */
const SHORT_WINDOW = /Per(Second|Minute)/i;

/** What Google's error details say about quota: the QuotaFailure violations and any RetryInfo. */
function quotaDetails(details) {
  const list = Array.isArray(details) ? details : [];
  const typeOf = (d) => String((d && d['@type']) || '');
  const violations = list
    .filter((d) => /QuotaFailure$/.test(typeOf(d)))
    .flatMap((d) => (Array.isArray(d.violations) ? d.violations : []))
    .map((v) => ({ quotaId: String((v && (v.quotaId || v.subject)) || ''), quotaValue: v && v.quotaValue != null ? String(v.quotaValue) : '' }));
  const retry = list.some((d) => /RetryInfo$/.test(typeOf(d)));
  const reasons = list.filter((d) => /ErrorInfo$/.test(typeOf(d))).map((d) => String(d.reason || ''));
  return { violations, retry, reasons };
}

/**
 * Is this failure the key's own trouble (quota, money, permission, a dead key) rather than a bad
 * request, a refusal of the content or a network blip? Takes an axios error or a { status, data } pair.
 *   - 'rate': a per-second or per-minute limit (QuotaFailure on a short window, or a RetryInfo
 *     with no money words). Logged, never alerted: it clears itself and must not use up the window.
 *   - 'quota': a daily or other long quota, or a 429 with nothing more said.
 *   - 'billing': money words (prepayment, credits, billing not enabled) once the rate-limit
 *     boilerplate is taken out, or HTTP 402.
 *   - 'invalid-key': 400 API_KEY_INVALID / API_KEY_EXPIRED (a deleted, rotated or expired key).
 *   - 'permission': 403 PERMISSION_DENIED.
 * @returns {{ kind: 'billing' | 'quota' | 'rate' | 'permission' | 'invalid-key', status: number | null, apiStatus: string, detail: string } | null}
 */
function googleKeyTrouble(error) {
  if (!error || typeof error !== 'object') return null;
  const response = error.response || (typeof error.status === 'number' ? error : null);
  if (!response) return null;
  const status = typeof response.status === 'number' ? response.status : null;
  let body = response.data;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = { error: { message: body } };
    }
  }
  if (Array.isArray(body)) body = body[0];
  const err = (body && typeof body === 'object' && body.error) || {};
  const apiStatus = typeof err.status === 'string' ? err.status : '';
  const message = typeof err.message === 'string' ? err.message : typeof err === 'string' ? err : '';
  let details = '';
  try {
    details = err.details ? JSON.stringify(err.details) : '';
  } catch (_) {
    details = '';
  }
  const said = `${message} ${details}`;
  const money = MONEY.test(said.replace(RATE_LIMIT_BOILERPLATE, ' '));
  const quota = quotaDetails(err.details);
  const exhausted = status === 429 || apiStatus === 'RESOURCE_EXHAUSTED';
  /* A limit of 0 is not a burst: the key has lost access to that quota altogether. */
  const shortOnly =
    quota.violations.length > 0 &&
    quota.violations.every((v) => SHORT_WINDOW.test(v.quotaId) && v.quotaValue !== '0');
  let kind = null;
  if (status === 402 || (money && (exhausted || status === 403 || status === 400 || apiStatus === 'FAILED_PRECONDITION'))) {
    kind = 'billing';
  } else if (exhausted) {
    kind = shortOnly || (quota.retry && quota.violations.length === 0) ? 'rate' : 'quota';
  } else if (
    (status === 400 || apiStatus === 'INVALID_ARGUMENT' || status === 401 || status === 403) &&
    (quota.reasons.some((r) => INVALID_KEY_REASONS.includes(r)) || INVALID_KEY_WORDS.test(message))
  ) {
    kind = 'invalid-key';
  } else if (status === 403 || apiStatus === 'PERMISSION_DENIED') {
    kind = 'permission';
  }
  if (!kind) return null;
  return { kind, status, apiStatus, detail: scrub(message || apiStatus || `HTTP ${status}`) };
}

const KIND_WORDS = {
  billing: 'Google says the key has a billing or prepaid-credit problem',
  quota: 'Google says the key is out of quota (429 RESOURCE_EXHAUSTED); on Aug 28 that was the prepaid credit running out',
  permission: 'Google refused the key (permission denied)',
  'invalid-key': 'Google says the key is not valid (deleted, rotated or expired)',
};

/** What she should look at, by kind. */
const KIND_CHECK = {
  billing: (keyName) => `Check the Google AI Studio balance for ${keyName}.`,
  quota: (keyName) => `Check the Google AI Studio balance and quota for ${keyName}.`,
  permission: (keyName) => `Check the Google AI Studio key behind ${keyName}: its billing and its API restrictions.`,
  'invalid-key': (keyName) => `Put a current Google AI Studio key in ${keyName} on Railway.`,
};

function defaultDeps() {
  let logger = console;
  try {
    logger = require('@librechat/data-schemas').logger || console;
  } catch (_) {
    /* console still says it */
  }
  return {
    logger,
    env: process.env,
    now: () => Date.now(),
    alert: (a) => require('~/server/services/kadeOwnerAlerts').alertOwner(a),
  };
}

/**
 * Log the trouble and, once per throttle window, tell Kade. Never throws. Resolves to what it did:
 * null when the failure is not the key's own trouble.
 * @param {string} lane what broke, in her words: 'memory recall', 'Lyria songs', 'the lyric transcriber'
 * @param {unknown} error
 * @param {{ keyName?: string }} [opts] the env var the key came from (a name, never the value)
 */
async function reportGoogleKeyTrouble(lane, error, opts = {}, deps = defaultDeps()) {
  try {
    const trouble = googleKeyTrouble(error);
    if (!trouble) return null;
    const keyName = opts.keyName || 'KADE_EMBED_GEMINI_KEY';
    const head = `${TAG} lane="${lane}" key=${keyName} kind=${trouble.kind} status=${trouble.status ?? '?'}${trouble.apiStatus ? ` ${trouble.apiStatus}` : ''}: ${trouble.detail}`;
    /* Part 295 review: a per-minute burst clears itself; it is logged, never alerted, and it does
     * not use up the window, so a real empty balance an hour later still reaches her. */
    if (trouble.kind === 'rate') {
      deps.logger.warn(`${head} -- a short rate limit, not alerting`);
      return { ...trouble, alerted: false };
    }
    const now = deps.now();
    const windowMs = alertHours(deps.env) * 3600e3;
    const last = state.lastAlertAt.get(keyName) || 0;
    const due = !last || now - last >= windowMs;
    deps.logger.warn(`${head}${due ? ' -- alerting Kade' : ' -- Kade already alerted'}`);
    if (!due) return { ...trouble, alerted: false };
    state.lastAlertAt.set(keyName, now);
    const words = KIND_WORDS[trouble.kind];
    const check = KIND_CHECK[trouble.kind](keyName);
    /* The embedding key is also the fallback for Lyria and the transcriber; a lane's own key is not. */
    const shared = keyName === 'KADE_EMBED_GEMINI_KEY' ? 'memory recall, Lyria songs and the lyric transcriber' : '';
    const receipt = await Promise.resolve(
      deps.alert({
        agentId: 'kade-google-key-alert',
        agentName: 'Google key',
        title: 'The Google key is failing',
        body: `${words}. It broke ${lane} just now${shared ? `; the same key runs ${shared}` : ''}. ${check}`,
        nudgeText: `The Google AI Studio key (${keyName}) is failing: ${words}. It broke ${lane} just now${shared ? `, and the same key runs ${shared}` : ''}. ${check} Google said: "${trouble.detail}"`,
        nudgeType: 'google-key',
      }),
    ).catch((e) => ({ failed: e && e.message }));
    deps.logger.info(`${TAG} alert sent: ${JSON.stringify(receipt || {}).slice(0, 200)}`);
    return { ...trouble, alerted: true };
  } catch (e) {
    try {
      deps.logger.warn(`${TAG} alarm failed (non-fatal): ${e && e.message}`);
    } catch (_) {
      /* never break the caller */
    }
    return null;
  }
}

/** Tests only: forget the last alert. */
function resetGoogleKeyAlarm() {
  state.lastAlertAt.clear();
}

module.exports = { googleKeyTrouble, reportGoogleKeyTrouble, resetGoogleKeyAlarm, alertHours, scrub };
