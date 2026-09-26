'use strict';
/* Part 295: the Google key alarm. On Aug 28 the AI Studio key's prepaid credit ran out and memory
 * recall went blind platform-wide with only a log warning; now the key's own trouble tells Kade.
 * Run: node --test api/server/services/kadeGoogleKeyAlarm.nodetest.js */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const A = require('./kadeGoogleKeyAlarm');

/** An axios-shaped HTTP failure from generativelanguage.googleapis.com. */
const googleError = (status, apiStatus, message, details) => ({
  message: `Request failed with status code ${status}`,
  config: { url: 'https://generativelanguage.googleapis.com/v1beta/models/x:embedContent?key=AIzaSyTESTONLYNOTAREALKEY12345' },
  response: { status, data: { error: { code: status, status: apiStatus, message, ...(details ? { details } : {}) } } },
});

function deps(env = {}) {
  const lines = [];
  const alerts = [];
  let now = Date.parse('2026-09-26T12:00:00Z');
  return {
    lines,
    alerts,
    advance: (ms) => (now += ms),
    d: {
      logger: { warn: (m) => lines.push(m), info: (m) => lines.push(m) },
      env,
      now: () => now,
      alert: async (a) => {
        alerts.push(a);
        return { nudge: true, push: 'sent=1' };
      },
    },
  };
}

beforeEach(() => A.resetGoogleKeyAlarm());

test("the key's own trouble is recognised; a bad request, a refused song or a network blip is not", () => {
  assert.equal(A.googleKeyTrouble(googleError(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).')).kind, 'quota');
  assert.equal(
    A.googleKeyTrouble(googleError(429, 'RESOURCE_EXHAUSTED', 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.')).kind,
    'billing',
  );
  assert.equal(A.googleKeyTrouble(googleError(403, 'PERMISSION_DENIED', 'Billing is not enabled for this project.')).kind, 'billing');
  assert.equal(
    A.googleKeyTrouble(googleError(403, 'PERMISSION_DENIED', 'Permission denied.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'BILLING_DISABLED' }])).kind,
    'billing',
  );
  assert.equal(A.googleKeyTrouble(googleError(403, 'PERMISSION_DENIED', 'Method doesn\'t allow unregistered callers.')).kind, 'permission');
  assert.equal(A.googleKeyTrouble(googleError(400, 'FAILED_PRECONDITION', 'Free tier is not available in your country. Please enable billing on your project.')).kind, 'billing');
  assert.equal(A.googleKeyTrouble(googleError(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.')), null);
  assert.equal(A.googleKeyTrouble(googleError(404, 'NOT_FOUND', 'models/lyria-3-5 is not found')), null);
  assert.equal(A.googleKeyTrouble(googleError(500, 'INTERNAL', 'An internal error has occurred.')), null);
  assert.equal(A.googleKeyTrouble(new Error('finish:RECITATION')), null, 'a refusal inside a 200 is not the key');
  assert.equal(A.googleKeyTrouble({ code: 'ECONNRESET', message: 'socket hang up' }), null);
  assert.equal(A.googleKeyTrouble(null), null);
  /* A streamed endpoint answers with an array; a proxy may hand back text. */
  assert.equal(A.googleKeyTrouble({ response: { status: 429, data: [{ error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' } }] } }).kind, 'quota');
  assert.equal(A.googleKeyTrouble({ response: { status: 429, data: 'Too Many Requests' } }).kind, 'quota');
});

/* Part 295 review: Google's own bodies, as the Gemini API sends them. */
const RATE_LIMIT_MESSAGE =
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.';
const quotaFailure = (quotaId, quotaValue = '1000') => ({
  '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
  violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_requests', quotaId, quotaDimensions: { location: 'global', model: 'gemini-3-flash' }, quotaValue }],
});
const HELP = { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] };
const RETRY = { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '13s' };
const invalidKey = (reason, message) =>
  googleError(400, 'INVALID_ARGUMENT', message, [
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } },
    { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message },
  ]);

test('a deleted, rotated or expired key is the key\'s own trouble (400 API_KEY_INVALID / API_KEY_EXPIRED)', async () => {
  const deleted = invalidKey('API_KEY_INVALID', 'API key not valid. Please pass a valid API key.');
  assert.equal(A.googleKeyTrouble(deleted).kind, 'invalid-key');
  assert.equal(A.googleKeyTrouble(invalidKey('API_KEY_EXPIRED', 'API key expired. Please renew the API key.')).kind, 'invalid-key');
  /* The words alone are enough when a proxy drops the details. */
  assert.equal(A.googleKeyTrouble(googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.')).kind, 'invalid-key');
  assert.equal(A.googleKeyTrouble(googleError(400, 'INVALID_ARGUMENT', 'Request contains an invalid argument.')), null, 'an ordinary bad request is still not the key');
  const h = deps();
  const r = await A.reportGoogleKeyTrouble('memory recall', deleted, {}, h.d);
  assert.equal(r.alerted, true);
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0].body, /not valid \(deleted, rotated or expired\)/);
  assert.match(h.alerts[0].body, /KADE_EMBED_GEMINI_KEY on Railway/);
  assert.match(h.lines[0], /kind=invalid-key status=400 INVALID_ARGUMENT/);
});

test('an ordinary per-minute rate limit is logged, not called a billing problem, and leaves the window for a real one', async () => {
  const burst = googleError(429, 'RESOURCE_EXHAUSTED', RATE_LIMIT_MESSAGE, [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel'), HELP, RETRY]);
  assert.equal(A.googleKeyTrouble(burst).kind, 'rate', '"check your plan and billing details" is boilerplate, not money');
  assert.equal(A.googleKeyTrouble(googleError(429, 'RESOURCE_EXHAUSTED', RATE_LIMIT_MESSAGE, [RETRY])).kind, 'rate', 'a RetryInfo alone is a burst');
  assert.equal(A.googleKeyTrouble(googleError(429, 'RESOURCE_EXHAUSTED', RATE_LIMIT_MESSAGE, [quotaFailure('GenerateRequestsPerDayPerProjectPerModel'), HELP, RETRY])).kind, 'quota', 'a daily quota is the key running dry for the day');
  assert.equal(A.googleKeyTrouble(googleError(429, 'RESOURCE_EXHAUSTED', RATE_LIMIT_MESSAGE, [quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '0'), HELP, RETRY])).kind, 'quota', 'a limit of 0 means access is gone, not a burst');
  assert.equal(A.googleKeyTrouble(googleError(429, 'RESOURCE_EXHAUSTED', RATE_LIMIT_MESSAGE)).kind, 'quota', 'a 429 with nothing more said still tells her');
  const h = deps();
  const first = await A.reportGoogleKeyTrouble('Lyria songs', burst, { keyName: 'KADE_EMBED_GEMINI_KEY' }, h.d);
  assert.equal(first.alerted, false);
  assert.equal(h.alerts.length, 0, 'no push about a burst');
  assert.match(h.lines[0], /kind=rate status=429 RESOURCE_EXHAUSTED: .* -- a short rate limit, not alerting$/);
  h.advance(60 * 60e3);
  const empty = await A.reportGoogleKeyTrouble('memory recall', googleError(429, 'RESOURCE_EXHAUSTED', 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.'), {}, h.d);
  assert.equal(empty.kind, 'billing');
  assert.equal(empty.alerted, true, 'the burst an hour ago did not use up the window');
  assert.equal(h.alerts.length, 1);
});

test('each key name has its own window: a separate Lyria key is heard on its own', async () => {
  const h = deps();
  const empty = googleError(429, 'RESOURCE_EXHAUSTED', 'Your prepayment credits are depleted.');
  assert.equal((await A.reportGoogleKeyTrouble('Lyria songs', empty, { keyName: 'KADE_LYRIA_KEY' }, h.d)).alerted, true);
  assert.doesNotMatch(h.alerts[0].body, /the same key runs/, 'a lane\'s own key runs only that lane');
  h.advance(10 * 60e3);
  assert.equal((await A.reportGoogleKeyTrouble('memory recall', empty, {}, h.d)).alerted, true, 'the embedding key is another key');
  assert.match(h.alerts[1].body, /the same key runs memory recall, Lyria songs and the lyric transcriber/);
  assert.equal((await A.reportGoogleKeyTrouble('Lyria songs', empty, { keyName: 'KADE_LYRIA_KEY' }, h.d)).alerted, false);
  assert.equal(h.alerts.length, 2);
});

test('the key never reaches the log or the alert, even when Google repeats it', () => {
  const t = A.googleKeyTrouble(googleError(403, 'PERMISSION_DENIED', 'API key AIzaSyTESTONLYNOTAREALKEY12345 is blocked; see ?key=AIzaSyTESTONLYNOTAREALKEY12345'));
  assert.doesNotMatch(t.detail, /AIzaSyTESTONLY/);
  assert.match(t.detail, /\[key\]/);
});

test('one clear line every time; Kade is told once, then not again inside the window', async () => {
  const h = deps();
  const empty = googleError(429, 'RESOURCE_EXHAUSTED', 'Your prepayment credits are depleted.');
  const first = await A.reportGoogleKeyTrouble('memory recall', empty, {}, h.d);
  assert.equal(first.alerted, true);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0].agentId, 'kade-google-key-alert');
  assert.match(h.alerts[0].body, /memory recall/);
  assert.match(h.alerts[0].body, /KADE_EMBED_GEMINI_KEY/);
  assert.match(h.alerts[0].nudgeText, /prepayment credits are depleted/);
  h.advance(60 * 60e3);
  const second = await A.reportGoogleKeyTrouble('Lyria songs', empty, { keyName: 'KADE_EMBED_GEMINI_KEY' }, h.d);
  assert.equal(second.alerted, false, 'the lanes share one key, so they share one alert');
  assert.equal(h.alerts.length, 1);
  const warned = h.lines.filter((l) => l.startsWith('[google-key-alarm] lane='));
  assert.equal(warned.length, 2, 'but every failure is logged');
  assert.match(warned[0], /lane="memory recall" key=KADE_EMBED_GEMINI_KEY kind=billing status=429 RESOURCE_EXHAUSTED/);
  assert.match(warned[1], /Kade already alerted/);
  h.advance(3 * 60 * 60e3 + 1);
  assert.equal((await A.reportGoogleKeyTrouble('the lyric transcriber', empty, {}, h.d)).alerted, true, 'four hours on, she hears again');
  assert.equal(h.alerts.length, 2);
});

test('the window is KADE_GOOGLE_KEY_ALERT_HOURS; junk falls back to four hours', async () => {
  assert.equal(A.alertHours({ KADE_GOOGLE_KEY_ALERT_HOURS: '1' }), 1);
  assert.equal(A.alertHours({ KADE_GOOGLE_KEY_ALERT_HOURS: 'soon' }), 4);
  assert.equal(A.alertHours({}), 4);
  const h = deps({ KADE_GOOGLE_KEY_ALERT_HOURS: '1' });
  const err = googleError(403, 'PERMISSION_DENIED', 'Permission denied.');
  await A.reportGoogleKeyTrouble('Lyria songs', err, { keyName: 'KADE_LYRIA_KEY' }, h.d);
  h.advance(60 * 60e3);
  await A.reportGoogleKeyTrouble('Lyria songs', err, { keyName: 'KADE_LYRIA_KEY' }, h.d);
  assert.equal(h.alerts.length, 2);
  assert.match(h.alerts[1].body, /KADE_LYRIA_KEY/);
});

test('anything else is ignored quietly, and a broken alert never throws', async () => {
  const h = deps();
  assert.equal(await A.reportGoogleKeyTrouble('memory recall', googleError(400, 'INVALID_ARGUMENT', 'bad'), {}, h.d), null);
  assert.equal(h.lines.length, 0);
  assert.equal(h.alerts.length, 0);
  const broken = { ...h.d, alert: async () => { throw new Error('bridge down'); } };
  const r = await A.reportGoogleKeyTrouble('memory recall', googleError(429, 'RESOURCE_EXHAUSTED', 'quota'), {}, broken);
  assert.equal(r.alerted, true);
  assert.match(h.lines.join('\n'), /alert sent: \{"failed":"bridge down"\}/);
});
