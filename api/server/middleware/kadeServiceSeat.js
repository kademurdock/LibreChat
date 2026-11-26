'use strict';
/* Nov 26 2026 (Part 461): the service seat.
 *
 * Once TRUST_PROXY is 2, req.ip is the real caller. Kade's own services (the
 * bridge, the inworld proxy, which carries the Canary probe and the battery
 * seat) call this site over the public domain from one Railway address each,
 * so every per-address limit and address ban would add them up and refuse
 * them. A request that carries the header X-Kade-Service with the value of
 * KADE_SERVICE_LIMIT_SECRET skips ONLY the per-address limits and the
 * address bans. It still has to sign in. Account bans still apply, and so do
 * the limits counted per account: the failed sign-in count per email or phone
 * (loginEmailLimiter, which has a separate bucket for services), and the
 * signed-in limits (messages, 2FA, uploads and the rest). The doorbell gives
 * services one shared hourly count instead of the per-address one. With the
 * variable unset, nothing is skipped.
 *
 * The header is read once, near the top of the app, and then removed from the
 * request, so no later logger, error report or forwarded request can carry it.
 * The value is never written to a log.
 */
const crypto = require('crypto');

const HEADER = 'x-kade-service';
const MIN_SECRET_LENGTH = 24;
const FLAG = Symbol.for('kade.serviceSeat');

let warnedBad = false;

/** The secret, or '' when the feature is off (unset, too short to be safe, or holding a comma). */
function serviceSecret(env = process.env) {
  const raw = env.KADE_SERVICE_LIMIT_SECRET;
  if (typeof raw !== 'string') return '';
  const secret = raw.trim();
  if (!secret) return '';
  if (secret.length < MIN_SECRET_LENGTH || secret.includes(',')) {
    if (!warnedBad) {
      warnedBad = true;
      // The rule only. Never the value.
      // eslint-disable-next-line no-console
      console.warn(
        `[kadeServiceSeat] KADE_SERVICE_LIMIT_SECRET must be at least ${MIN_SECRET_LENGTH} characters with no comma, so the service seat is off`,
      );
    }
    return '';
  }
  return secret;
}

/** Same-time comparison: both sides are hashed first, so length does not leak either. */
function sameSecret(given, secret) {
  if (typeof given !== 'string' || !given || !secret) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(secret, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** True when the request's header matches the secret. Reads the header; does not remove it. */
function headerMatches(req, env = process.env) {
  const secret = serviceSecret(env);
  if (!secret) return false;
  const value = req && req.headers ? req.headers[HEADER] : undefined;
  // Node joins a repeated header into one value with commas ("a, b"). The
  // secret never has a comma, so a joined value is refused outright. An array
  // (only possible when a test builds the request by hand) is refused too.
  if (Array.isArray(value)) return false;
  if (typeof value === 'string' && value.includes(',')) return false;
  return sameSecret(value, secret);
}

/** Take the header off the request so nothing later can log or forward it. */
function scrubHeader(req) {
  if (!req || !req.headers) return;
  delete req.headers[HEADER];
  if (Array.isArray(req.rawHeaders)) {
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === HEADER) req.rawHeaders.splice(i, 2);
    }
  }
}

/**
 * Is this request from one of Kade's own services?
 * Uses the answer the app-level middleware saved; if that middleware did not
 * run (a route tested on its own), it reads the header directly.
 * Takes the request only, so it can be handed straight to express-rate-limit's
 * skip option, which calls skip(req, res).
 */
function isKadeService(req) {
  if (!req) return false;
  if (Object.prototype.hasOwnProperty.call(req, FLAG)) return req[FLAG] === true;
  return headerMatches(req, process.env);
}

/** App-level middleware: decide once, remember it on the request, remove the header. */
function kadeServiceSeat() {
  return function kadeServiceSeatMiddleware(req, _res, next) {
    const ok = headerMatches(req, process.env);
    Object.defineProperty(req, FLAG, { value: ok, enumerable: false, configurable: true });
    scrubHeader(req);
    next();
  };
}

module.exports = {
  HEADER,
  MIN_SECRET_LENGTH,
  isKadeService,
  kadeServiceSeat,
  serviceSecret,
  sameSecret,
  scrubHeader,
};
