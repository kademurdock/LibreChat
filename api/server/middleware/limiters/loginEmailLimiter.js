'use strict';
/* Nov 26 2026 (Part 461, review fix): failed sign-ins counted per account name.
 *
 * Before this, the only sign-in throttle was loginLimiter, which counts by
 * address. Kade's own services skip that one (the service seat), and anyone
 * with many addresses could spread guesses across them. This limiter counts
 * FAILED sign-ins for one email address or phone number, whoever sends them,
 * and the service seat does NOT skip it.
 *
 * - Only failures count. A correct sign-in takes its count back off, so the
 *   bridge's normal sign-ins every 20 minutes never add up.
 * - Requests from a service and requests from everyone else are counted in two
 *   separate buckets. So a stranger on the web cannot lock the bridge out of an
 *   account by failing on purpose, and guesses relayed through the bridge are
 *   still capped.
 * - The answer is the same for an account that exists and one that does not,
 *   so it never tells anyone which addresses have accounts.
 * - The account name is stored only as a hash, and never written to a log here.
 *
 * Settings: LOGIN_EMAIL_WINDOW (minutes, default 15) and LOGIN_EMAIL_MAX
 * (failures in that window, default 10).
 */
const { createHash } = require('crypto');
const rateLimit = require('express-rate-limit');
const { limiterCache } = require('@librechat/api');
const { isKadeService } = require('../kadeServiceSeat');
const { classifyLoginId } = require('../../utils/kadeLoginId');

const { LOGIN_EMAIL_WINDOW = 15, LOGIN_EMAIL_MAX = 10 } = process.env;
const windowMs = Number(LOGIN_EMAIL_WINDOW) * 60 * 1000;
const max = Number(LOGIN_EMAIL_MAX);
const windowInMinutes = windowMs / 60000;
const message = `Too many login attempts, please try again after ${windowInMinutes} minutes.`;

/** The account name a sign-in is for, made the same however it was typed. '' when there is none. */
function loginName(req) {
  const raw = req && req.body ? req.body.email : undefined;
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  const id = classifyLoginId(text);
  if (id.kind === 'phone') return `phone:${id.phone}`;
  return `email:${text.toLowerCase()}`;
}

/** The limiter key: which bucket (service or web) plus a hash of the account name. */
function loginNameKey(req) {
  const lane = isKadeService(req) ? 'service' : 'web';
  const hash = createHash('sha256').update(loginName(req)).digest('hex');
  return `${lane}:${hash}`;
}

const limiterOptions = {
  windowMs,
  max,
  keyGenerator: loginNameKey,
  /* A sign-in with no account name fails validation anyway; nothing to count.
   * Deliberately NOT skipped for a service. */
  skip: (req) => !loginName(req),
  skipSuccessfulRequests: true,
  handler: (_req, res) => res.status(429).json({ message }),
  store: limiterCache('login_email_limiter'),
};

const loginEmailLimiter = rateLimit(limiterOptions);

module.exports = loginEmailLimiter;
module.exports.loginName = loginName;
module.exports.loginNameKey = loginNameKey;
