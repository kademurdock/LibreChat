'use strict';
/* SERVER-TO-SERVER MAINTENANCE CALLS (Sep 25 2026). A few librarian and funding routes are run by
 * Kade's own tools rather than by a signed-in browser. They accept either the route's normal admin
 * sign-in, or the header `x-kade-ops-secret` carrying KADE_OPS_SECRET (a Railway variable).
 *
 *   hasOpsSecret(req)      true only when KADE_OPS_SECRET is set (non-empty) and the header matches
 *                          it exactly, compared in constant time.
 *   opsOrAdmin(isAdminFn)  express middleware: the secret lets the call through with
 *                          `req.kadeOps = true` and no signed-in user (req.user stays unset, so a
 *                          route never acts as anyone's account); otherwise the normal JWT sign-in
 *                          runs and `isAdminFn(req)` must say yes (403 when it does not).
 *
 * The secret is never logged and never echoed back. */
const { timingSafeEqual } = require('node:crypto');

const HEADER = 'x-kade-ops-secret';

function hasOpsSecret(req) {
  const secret = String(process.env.KADE_OPS_SECRET || '');
  if (!secret) return false;
  const raw = req && req.headers ? req.headers[HEADER] : undefined;
  const given = Array.isArray(raw) ? raw[0] : raw;
  if (typeof given !== 'string' || !given) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function opsOrAdmin(isAdminFn) {
  return function kadeOpsOrAdmin(req, res, next) {
    if (hasOpsSecret(req)) {
      req.kadeOps = true;
      return next();
    }
    const requireJwtAuth = require('./requireJwtAuth');
    return requireJwtAuth(req, res, (err) => {
      if (err) return next(err);
      if (!isAdminFn(req)) return res.status(403).json({ error: 'Only an admin can do that.' });
      return next();
    });
  };
}

module.exports = { opsOrAdmin, hasOpsSecret, HEADER };
