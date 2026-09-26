'use strict';
/**
 * KADE Sep 26 2026 (Part 295) — THE GOOGLE KEY ALARM.
 *
 * One AI Studio key on this service (KADE_EMBED_GEMINI_KEY) feeds memory embeddings
 * (models/kadeDiary.js), Lyria songs (routes/kadeSoundBooth.js) and the lyric transcriber
 * (packages/api music/lyrics.ts). On Aug 28 its prepaid credit ran out: every embedding answered
 * 429, memory recall went blind platform-wide, and for days the only trace was a warning in the
 * log. Now a Google refusal that looks like the key itself (429 RESOURCE_EXHAUSTED, a billing or
 * prepayment error, a 403 PERMISSION_DENIED) logs one clear line every time and tells Kade at most
 * once every few hours (KADE_GOOGLE_KEY_ALERT_HOURS, default 4) through the owner-alert lane
 * (kadeOwnerAlerts.alertOwner: a chat nudge plus a bridge /notify adminAlert push; mute
 * 'kade-google-key-alert' in notify-prefs). One throttle for the whole key: the lanes share it,
 * so one empty balance is one alert, not three. The throttle lives in memory, so a redeploy can
 * alert again once.
 *
 * Search the logs for: [google-key-alarm]
 *
 * Never prints the key: nothing here reads the request URL (kadeDiary puts the key in it) or
 * headers, only the response status and Google's own error text, with anything shaped like a key
 * masked. No '~' requires at the top, so node --test loads it.
 */

const TAG = '[google-key-alarm]';
const DEFAULT_HOURS = 4;
const state = { lastAlertAt: 0 };

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
 * Is this failure the key's own trouble (quota, money, permission) rather than a bad request, a
 * refusal of the content or a network blip? Takes an axios error or a { status, data } pair.
 * @returns {{ kind: 'billing' | 'quota' | 'permission', status: number | null, apiStatus: string, detail: string } | null}
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
  const money = /billing|prepa(y|id)|credit|payment|insufficient.?funds|out of funds/i.test(`${message} ${details}`);
  let kind = null;
  if (status === 402 || (money && (status === 429 || status === 403 || status === 400 || apiStatus === 'FAILED_PRECONDITION'))) {
    kind = 'billing';
  } else if (status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    kind = 'quota';
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
    const now = deps.now();
    const windowMs = alertHours(deps.env) * 3600e3;
    const due = !state.lastAlertAt || now - state.lastAlertAt >= windowMs;
    deps.logger.warn(
      `${TAG} lane="${lane}" key=${keyName} kind=${trouble.kind} status=${trouble.status ?? '?'}${trouble.apiStatus ? ` ${trouble.apiStatus}` : ''}: ${trouble.detail}${due ? ' -- alerting Kade' : ' -- Kade already alerted'}`,
    );
    if (!due) return { ...trouble, alerted: false };
    state.lastAlertAt = now;
    const words = KIND_WORDS[trouble.kind];
    const breaks = 'memory recall, Lyria songs and the lyric transcriber';
    const receipt = await Promise.resolve(
      deps.alert({
        agentId: 'kade-google-key-alert',
        agentName: 'Google key',
        title: 'The Google key is failing',
        body: `${words}. It broke ${lane} just now; the same key runs ${breaks}. Check the Google AI Studio balance for ${keyName}.`,
        nudgeText: `The Google AI Studio key (${keyName}) is failing: ${words}. It broke ${lane} just now, and the same key runs ${breaks}. Top up or check billing in Google AI Studio. Google said: "${trouble.detail}"`,
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
  state.lastAlertAt = 0;
}

module.exports = { googleKeyTrouble, reportGoogleKeyTrouble, resetGoogleKeyAlarm, alertHours, scrub };
