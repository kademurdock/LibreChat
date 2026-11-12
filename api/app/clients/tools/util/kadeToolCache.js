'use strict';
/**
 * KADE: a short-lived, in-memory cache for read-only public tool lookups, shared by every
 * character. One character's weather lookup answers the next one's for a few minutes, and two
 * identical lookups that overlap share one outside request.
 *
 *   - Keyed on tool name + scope + cleaned arguments. No character id in the key.
 *   - Nov 12 2026 (phase 4 build): every caller passes the PERSON being served as `scope`
 *     (services/kadeAccountType.audienceOf, so a phone caller on the service seat is the caller,
 *     never the seat) and calls straight out when there is no known person (`scopeOrNull`).
 *     Characters of one person share; two people never share a result or a running lookup.
 *   - A result is stored only when the tool's own `cacheable` test says it is a real answer.
 *   - Bounded (MAX entries), memory only, nothing written to disk.
 *   - KADE_TOOL_CACHE=0 off; =shadow counts would-be hits and still calls out; unset = on.
 * Callers must not change a returned value in place: it may be shared.
 * No '~' requires, so node --test loads it.
 */

const MAX = 400;
const MAX_VALUE_CHARS = 60000;

/** key -> { at, ttl, value } (insertion order = age) */
const store = new Map();
/** key -> Promise of a lookup that is running now */
const flights = new Map();
/** key -> last time this lookup was seen (noteRepeat only) */
const seen = new Map();
const counts = { hit: 0, miss: 0, shared: 0, skipped: 0, shadow: 0, repeat: 0, unscoped: 0 };

function mode(env = process.env) {
  const v = String(env.KADE_TOOL_CACHE || '').trim().toLowerCase();
  if (v === '0' || v === 'off') return 'off';
  if (v === 'shadow') return 'shadow';
  return 'on';
}

function clean(value, exact) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const s = value.trim().replace(/\s+/g, ' ');
    return exact ? s : s.toLowerCase();
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, exact));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = clean(value[k], exact);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return String(value);
}

function keyOf(tool, args, scope, exact) {
  return `${tool}|${scope || 'all'}|${JSON.stringify(clean(args, exact))}`;
}

function defaultCacheable(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_CHARS;
}

function put(key, value, ttl, at) {
  store.delete(key);
  store.set(key, { at, ttl, value });
  if (store.size > MAX) {
    for (const [k, v] of store) {
      if (at - v.at >= v.ttl) store.delete(k);
    }
  }
  while (store.size > MAX) store.delete(store.keys().next().value);
}

/**
 * Run `fn` unless a fresh answer for the same lookup is already here.
 * @param {{ tool: string, args: any, ttlMs: number, scope?: string, exact?: boolean,
 *           cacheable?: (v: any) => boolean, env?: object, now?: () => number }} opts
 * @param {() => Promise<any>} fn the real lookup
 */
async function cached(opts, fn) {
  const o = opts || {};
  const m = mode(o.env);
  if (m === 'off' || !o.tool || !(o.ttlMs > 0)) return fn();
  const now = o.now || Date.now;
  let key;
  try {
    key = keyOf(o.tool, o.args, o.scope, o.exact === true);
  } catch (_) {
    return fn();
  }
  const kept = store.get(key);
  if (kept && now() - kept.at < kept.ttl) {
    if (m === 'shadow') {
      counts.shadow += 1;
      return fn();
    }
    counts.hit += 1;
    return kept.value;
  }
  if (kept) store.delete(key);
  if (m === 'on') {
    const flying = flights.get(key);
    if (flying) {
      counts.shared += 1;
      return flying;
    }
  }
  counts.miss += 1;
  const flight = (async () => fn())();
  if (m === 'on') flights.set(key, flight);
  try {
    const value = await flight;
    let keep = false;
    try {
      keep = (o.cacheable || defaultCacheable)(value) === true;
    } catch (_) {
      keep = false;
    }
    if (keep) put(key, value, o.ttlMs, now());
    else counts.skipped += 1;
    return value;
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

/**
 * Count-only: was this same lookup seen within ttlMs? Stores a timestamp, never a result.
 * Used for web_search, whose answers are not reused yet.
 */
function noteRepeat({ tool, args, scope, ttlMs, exact, env, now = Date.now }) {
  if (mode(env) === 'off') return false;
  let key;
  try {
    key = keyOf(tool, args, scope, exact === true);
  } catch (_) {
    return false;
  }
  const t = now();
  const last = seen.get(key);
  seen.delete(key);
  seen.set(key, t);
  while (seen.size > MAX) seen.delete(seen.keys().next().value);
  if (last !== undefined && t - last < ttlMs) {
    counts.repeat += 1;
    return true;
  }
  return false;
}

/**
 * The person a tool call serves, as a cache scope, or null when nobody known is served.
 * Uses audienceOf: on a phone turn the request runs as the service seat, and the person on the
 * line (kadeOnBehalfOf) is the scope; an unknown caller on that seat gets null, so no cache.
 * @param {object | undefined} req
 * @returns {string | null}
 */
function personScope(req) {
  try {
    const { audienceOf } = require('../../../../server/services/kadeAccountType');
    const who = audienceOf(req).user;
    const id = who && (who.id || who._id);
    const s = id === undefined || id === null ? '' : String(id).trim();
    return s ? `u:${s}` : null;
  } catch (_) {
    return null;
  }
}

/**
 * `cached` for a lookup made for one person. No person = straight out, nothing kept or shared.
 * @param {object | undefined} req the turn's request
 * @param {object} opts as for `cached`, without `scope`
 * @param {() => Promise<any>} fn
 */
function cachedForPerson(req, opts, fn) {
  const scope = personScope(req);
  if (!scope) {
    if (mode(opts && opts.env) !== 'off') counts.unscoped += 1;
    return fn();
  }
  return cached({ ...opts, scope }, fn);
}

function snapshot() {
  return { ...counts, entries: store.size, flights: flights.size };
}

/** Tests only. */
function reset() {
  store.clear();
  flights.clear();
  seen.clear();
  for (const k of Object.keys(counts)) counts[k] = 0;
}

module.exports = { MAX, mode, keyOf, cached, cachedForPerson, personScope, noteRepeat, snapshot, reset };
