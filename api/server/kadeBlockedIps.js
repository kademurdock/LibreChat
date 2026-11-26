'use strict';
/* Nov 26 2026 — an outside address (195.160.221.181, NL hosting) signed in to Kade's admin account with her real password
 * and bulk-read the admin message logs, memories and diary. Railway has no firewall and the app's req.ip is Railway's edge
 * node (TRUST_PROXY unset), so this checks every address in X-Forwarded-For as well as the socket address.
 * KADE_BLOCKED_IPS: comma-separated exact addresses; unset = the default below; "none" = block nothing.
 */
const { logger } = require('@librechat/data-schemas');

const DEFAULT_BLOCKED = '195.160.221.181';

function blockedSet(env = process.env) {
  const raw = env.KADE_BLOCKED_IPS == null || env.KADE_BLOCKED_IPS === '' ? DEFAULT_BLOCKED : env.KADE_BLOCKED_IPS;
  if (String(raw).trim().toLowerCase() === 'none') return new Set();
  return new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean));
}

function requestAddresses(req) {
  const out = [];
  const xff = req.headers && req.headers['x-forwarded-for'];
  const list = Array.isArray(xff) ? xff.join(',') : String(xff || '');
  for (const part of list.split(',')) {
    const a = part.trim();
    if (a) out.push(a);
  }
  const sock = req.socket && req.socket.remoteAddress;
  if (sock) out.push(String(sock).replace('::ffff:', ''));
  return out;
}

let lastLog = 0;
let blockedCount = 0;

function kadeBlockedIps() {
  const blocked = blockedSet();
  if (blocked.size) logger.warn(`[kadeBlockedIps] blocking ${blocked.size} address(es)`);
  return function kadeBlockedIpsMiddleware(req, res, next) {
    if (!blocked.size) return next();
    const hit = requestAddresses(req).find((a) => blocked.has(a));
    if (!hit) return next();
    blockedCount++;
    const now = Date.now();
    if (now - lastLog > 60000) {
      lastLog = now;
      logger.warn(`[kadeBlockedIps] refused ${hit} (${blockedCount} refused so far) ${req.method} ${String(req.path || '').slice(0, 80)}`);
    }
    res.status(403).set('Connection', 'close').send('Forbidden');
  };
}

module.exports = { kadeBlockedIps, blockedSet, requestAddresses, DEFAULT_BLOCKED };
