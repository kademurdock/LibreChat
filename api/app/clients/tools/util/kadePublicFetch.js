'use strict';
/* ----------------------------------------------------------------------------
 * FETCHING A LINK SOMEONE ELSE CHOSE, FROM INSIDE OUR OWN NETWORK
 * (Nov 26 2026, Part 460; the page reader's Nov 13 guard, moved here so every
 * tool shares one copy).
 *
 * The website runs inside Railway's private network. A link typed by a person
 * or picked by a character can point at http://<service>.railway.internal,
 * localhost, the cloud metadata address, or a public name that answers with a
 * private address. On Nov 26 the news tool's custom feed_url was used to probe
 * *.railway.internal and 127.0.0.1:9229, because it only checked for "http".
 *
 * isPrivateTarget(url) refuses, before anything is fetched:
 *  - anything that is not http or https;
 *  - railway.internal and every name under it, localhost and *.localhost,
 *    *.internal, *.local and well-known inside names (mongo, redis...);
 *  - loopback 127/8, 0.0.0.0/8, private 10/8, 172.16/12, 192.168/16,
 *    link-local 169.254/16 (the metadata address), CGNAT 100.64/10, and IPv6
 *    ::1, ::, fc00::/7 (unique-local) and fe80::/10 (link-local), also when
 *    written as a mapped IPv4 address;
 *  - a name whose DNS answers include any of those addresses (every answer
 *    is checked, not just the first).
 * The address lists are the fork's own (packages/api/src/auth/ip.ts and
 * domain.ts isSSRFTarget / resolveHostnameSSRF).
 *
 * fetchPublic(url, options) then GETs with redirects followed by hand
 * (maxRedirects 0), checking every hop the same way, and connects through
 * createSSRFSafeAgents, which refuses a private address at connect time. That
 * covers a name that gives a public answer to the check and a private one to
 * the connection a moment later.
 *
 * If the fork's helpers cannot be loaded, everything is refused.
 * -------------------------------------------------------------------------- */

const PRIVATE_REFUSAL =
  "I can't read that address: it points inside a private network, not to a public web page.";

class PrivateTargetError extends Error {}

/** The fork's address checks, or null when they cannot be loaded (then everything is refused). */
function loadSsrfHelpers() {
  try {
    const api = require('@librechat/api');
    if (typeof api.isSSRFTarget === 'function' && typeof api.resolveHostnameSSRF === 'function') {
      return api;
    }
  } catch (_) {
    /* fall through: refused by the callers */
  }
  return null;
}

/**
 * True when this address must not be fetched from the server. Fails closed.
 * @param {string} rawUrl
 * @param {{ helpers?: object | null }} [deps]
 */
async function isPrivateTarget(rawUrl, deps = {}) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch (_) {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return true;
  }
  const host = u.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '');
  if (!host) {
    return true;
  }
  if (host === 'railway.internal' || host.endsWith('.railway.internal')) {
    return true;
  }
  const helpers = 'helpers' in deps ? deps.helpers : loadSsrfHelpers();
  if (!helpers) {
    return true;
  }
  if (helpers.isSSRFTarget(host)) {
    return true;
  }
  try {
    return (await helpers.resolveHostnameSSRF(host)) === true;
  } catch (_) {
    return true;
  }
}

/**
 * GET with every hop checked. Throws PrivateTargetError when a hop is private.
 * @param {string} url
 * @param {object} options axios options (maxRedirects, validateStatus and the agents are set here)
 * @param {{ get?: Function, helpers?: object | null, maxHops?: number, refusal?: string }} [deps]
 */
async function fetchPublic(url, options = {}, deps = {}) {
  const helpers = 'helpers' in deps ? deps.helpers : loadSsrfHelpers();
  const get = deps.get || require('axios').get;
  const maxHops = Number.isInteger(deps.maxHops) && deps.maxHops >= 0 ? deps.maxHops : 3;
  const refusal = deps.refusal || PRIVATE_REFUSAL;
  const agents =
    helpers && typeof helpers.createSSRFSafeAgents === 'function'
      ? helpers.createSSRFSafeAgents()
      : {};
  let current = String(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    if (await isPrivateTarget(current, { helpers })) {
      throw new PrivateTargetError(refusal);
    }
    const r = await get(current, {
      ...options,
      ...agents,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    if (r.status < 300) {
      return r;
    }
    const location = r.headers && (r.headers.location || r.headers.Location);
    if (!location) {
      throw new Error(`Request failed with status code ${r.status}`);
    }
    current = new URL(String(location), current).toString();
  }
  throw new Error('too many redirects');
}

module.exports = {
  isPrivateTarget,
  fetchPublic,
  loadSsrfHelpers,
  PrivateTargetError,
  PRIVATE_REFUSAL,
};
