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
/* Nov 26 2026 (Part 461 review fix): which service it is. Not a secret: the
 * bridge sends 'bridge' and the inworld proxy sends 'inworld-proxy'. It only
 * counts on a request whose X-Kade-Service matched, and it keeps each
 * service's failed sign-ins in a count of its own (loginEmailLimiter.js), so
 * one service holding a stale password cannot lock another out. */
const NAME_HEADER = 'x-kade-service-name';
const MIN_SECRET_LENGTH = 24;
const FLAG = Symbol.for('kade.serviceSeat');
const NAME_FLAG = Symbol.for('kade.serviceSeatName');

let warnedBad = false;
/* One-time log lines, so the logs show whether the seat is really working
 * before TRUST_PROXY=2 goes on. None of them ever holds the value. */
let saidStartup = false;
let saidUnsetButSent = false;
let saidMismatch = false;
const recognisedNames = new Set();

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
  delete req.headers[NAME_HEADER];
  if (Array.isArray(req.rawHeaders)) {
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      const name = String(req.rawHeaders[i]).toLowerCase();
      if (name === HEADER || name === NAME_HEADER) req.rawHeaders.splice(i, 2);
    }
  }
}

/** The service's name from X-Kade-Service-Name: lower case letters, digits and dashes, at most 32. 'unnamed' otherwise. */
function cleanServiceName(value) {
  if (typeof value !== 'string') return 'unnamed';
  const name = value.trim().toLowerCase();
  return /^[a-z0-9-]{1,32}$/.test(name) ? name : 'unnamed';
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

/**
 * Which service a request is from, for keeping counts apart. Only for a
 * request that is a service; '' for everyone else.
 */
function kadeServiceName(req) {
  if (!isKadeService(req)) return '';
  if (Object.prototype.hasOwnProperty.call(req, NAME_FLAG)) return req[NAME_FLAG];
  return cleanServiceName(req.headers ? req.headers[NAME_HEADER] : undefined);
}

/* The one-time lines. The first recognised request from each service name is
 * the sign to look for before switching TRUST_PROXY to 2. */
function noteOutcome(req, ok, name) {
  if (ok) {
    if (!recognisedNames.has(name) && recognisedNames.size < 20) {
      recognisedNames.add(name);
      // eslint-disable-next-line no-console
      console.info(`[kadeServiceSeat] first service request recognised from "${name}"`);
    }
    return;
  }
  const sent = req && req.headers && req.headers[HEADER] !== undefined;
  if (!sent) return;
  if (!serviceSecret(process.env)) {
    if (!saidUnsetButSent) {
      saidUnsetButSent = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[kadeServiceSeat] a request carried X-Kade-Service, but the service seat is off on the site (KADE_SERVICE_LIMIT_SECRET unset or refused)',
      );
    }
  } else if (!saidMismatch) {
    saidMismatch = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[kadeServiceSeat] a request carried X-Kade-Service that did not match KADE_SERVICE_LIMIT_SECRET (a stranger, or a service holding a different value)',
    );
  }
}

/** App-level middleware: decide once, remember it on the request, remove the header. */
function kadeServiceSeat() {
  if (!saidStartup) {
    saidStartup = true;
    // eslint-disable-next-line no-console
    console.info(
      serviceSecret(process.env)
        ? '[kadeServiceSeat] service seat is on'
        : '[kadeServiceSeat] service seat is off (KADE_SERVICE_LIMIT_SECRET unset or refused): services are counted by address like everyone else',
    );
  }
  return function kadeServiceSeatMiddleware(req, _res, next) {
    const ok = headerMatches(req, process.env);
    const name = ok ? cleanServiceName(req.headers[NAME_HEADER]) : '';
    Object.defineProperty(req, FLAG, { value: ok, enumerable: false, configurable: true });
    Object.defineProperty(req, NAME_FLAG, { value: name, enumerable: false, configurable: true });
    noteOutcome(req, ok, name);
    scrubHeader(req);
    next();
  };
}

module.exports = {
  HEADER,
  NAME_HEADER,
  MIN_SECRET_LENGTH,
  cleanServiceName,
  isKadeService,
  kadeServiceName,
  kadeServiceSeat,
  serviceSecret,
  sameSecret,
  scrubHeader,
};
