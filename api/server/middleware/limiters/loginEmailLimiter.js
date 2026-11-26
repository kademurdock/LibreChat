'use strict';
/* Nov 26 2026 (Part 461, review fix): failed sign-ins counted per account name.
 *
 * Before this, the only sign-in throttle was loginLimiter, which counts by
 * address. Kade's own services skip that one (the service seat), and anyone
 * with many addresses could spread guesses across them. This limiter counts
 * FAILED sign-ins for one email address or phone number, and the service seat
 * does NOT skip it.
 *
 * - Only failures count. A correct sign-in takes its count back off, so the
 *   bridge's normal sign-ins every 20 minutes never add up.
 * - Everyone who is not a service is counted per account name AND address
 *   (LOGIN_EMAIL_MAX in LOGIN_EMAIL_WINDOW). So a stranger who knows Kade's
 *   email and fails on purpose fills only their own count. Kade signing in
 *   from her own address is not stopped by it. (Second review, Nov 26: the
 *   first version counted the account name alone, so 11 wrong posts from one
 *   stranger kept her out of web, iPhone and Android sign-in.) The address is
 *   the real caller only once TRUST_PROXY=2 is on; before that it is Railway's
 *   edge, the same as loginLimiter.
 * - Behind that, a much looser count per account name from every address
 *   together (LOGIN_EMAIL_SPREAD_MAX in LOGIN_EMAIL_SPREAD_WINDOW, default 100
 *   an hour) stops guesses spread over many addresses. Locking someone out
 *   through it takes several addresses failing at full speed for an hour.
 *   LOGIN_EMAIL_SPREAD_MAX=0 turns this backstop off.
 * - Each service has a count of its own per account name (the non-secret
 *   X-Kade-Service-Name header, see kadeServiceSeat.js). So a stranger on the
 *   web cannot lock the bridge out, one service holding a stale password
 *   cannot lock another one out, and guesses relayed through the bridge are
 *   still capped. Services skip the spread backstop.
 * - The answer is the same for an account that exists and one that does not,
 *   so it never tells anyone which addresses have accounts.
 * - The account name is stored only as a hash, and never written to a log here.
 *
 * Settings: LOGIN_EMAIL_WINDOW (minutes, default 15), LOGIN_EMAIL_MAX
 * (failures in that window, default 10), LOGIN_EMAIL_SPREAD_WINDOW (minutes,
 * default 60), LOGIN_EMAIL_SPREAD_MAX (default 100, 0 = off).
 */
const { createHash } = require('crypto');
const rateLimit = require('express-rate-limit');
const { limiterCache, removePorts } = require('@librechat/api');
const { isKadeService, kadeServiceName } = require('../kadeServiceSeat');
const { classifyLoginId } = require('../../utils/kadeLoginId');

const {
  LOGIN_EMAIL_WINDOW = 15,
  LOGIN_EMAIL_MAX = 10,
  LOGIN_EMAIL_SPREAD_WINDOW = 60,
  LOGIN_EMAIL_SPREAD_MAX = 100,
} = process.env;
const windowMs = Number(LOGIN_EMAIL_WINDOW) * 60 * 1000;
const max = Number(LOGIN_EMAIL_MAX);
const spreadWindowMs = Number(LOGIN_EMAIL_SPREAD_WINDOW) * 60 * 1000;
const spreadMax = Number(LOGIN_EMAIL_SPREAD_MAX);
const windowInMinutes = windowMs / 60000;
const message = `Too many login attempts, please try again after ${windowInMinutes} minutes.`;
const spreadMessage = `Too many login attempts, please try again after ${spreadWindowMs / 60000} minutes.`;

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

const nameHash = (req) => createHash('sha256').update(loginName(req)).digest('hex');

/**
 * The limiter key. A service: its own name plus a hash of the account name.
 * Everyone else: a hash of the account name plus the address.
 */
function loginNameKey(req) {
  if (isKadeService(req)) return `service:${kadeServiceName(req)}:${nameHash(req)}`;
  return `web:${nameHash(req)}:${removePorts(req) || 'unknown'}`;
}

/** The backstop key: the account name alone, for everyone who is not a service. */
function loginSpreadKey(req) {
  return `spread:${nameHash(req)}`;
}

const perAddress = rateLimit({
  windowMs,
  max,
  keyGenerator: loginNameKey,
  /* A sign-in with no account name fails validation anyway; nothing to count.
   * Deliberately NOT skipped for a service. */
  skip: (req) => !loginName(req),
  skipSuccessfulRequests: true,
  handler: (_req, res) => res.status(429).json({ message }),
  store: limiterCache('login_email_limiter'),
});

const spread =
  spreadMax > 0
    ? rateLimit({
        windowMs: spreadWindowMs,
        max: spreadMax,
        keyGenerator: loginSpreadKey,
        skip: (req) => !loginName(req) || isKadeService(req),
        skipSuccessfulRequests: true,
        handler: (_req, res) => res.status(429).json({ message: spreadMessage }),
        store: limiterCache('login_email_spread_limiter'),
      })
    : null;

/** Both counts in order: per account name and address first, then the spread backstop. */
function loginEmailLimiter(req, res, next) {
  perAddress(req, res, (err) => {
    if (err) return next(err);
    if (!spread) return next();
    return spread(req, res, next);
  });
}

module.exports = loginEmailLimiter;
module.exports.loginName = loginName;
module.exports.loginNameKey = loginNameKey;
module.exports.loginSpreadKey = loginSpreadKey;
