'use strict';
/* KADE Nov 12 2026 (Kade's decision 24: voice speed, delivery and fillers are "Same on every device").
 *
 * GET /api/kade/voice-prefs keeps its old shape ({ prefs: { agentId: voice } }, which both apps decode as
 * a string map) and gains a sibling:
 *
 *   "listener": {
 *     "pace": 1.2,                 // null = the character's own speed; absent = never saved
 *     "paceAt": "2026-11-12T...",  // server stamp of the last write
 *     "fillers": false, "fillersAt": "...",
 *     "delivery": { "agent_abc": "STABLE", "library-reading": "BALANCED" }, "deliveryAt": "..."
 *   }
 *
 * PUT /api/kade/voice-prefs (or POST with { listener: {...} } and no agentId, for clients without PUT)
 * takes any of { pace, fillers, delivery } and answers { ok: true, listener }. `delivery` merges per
 * character; a null value clears that character. Unknown or bad values are refused field by field.
 *
 * The rule every client follows (the website's is client/src/utils/listenerVoiceSync.ts): speech always
 * uses the value on the device, at once. The account value is applied when it arrives, and when its stamp
 * differs from the last stamp this device saw. A change made on the device is saved locally first, marked
 * pending, then sent; a pending change wins over the account value until the server takes it.
 *
 * Kill switch: KADE_LISTENER_PREFS=0 leaves `listener` out of GET and refuses the write with 404, so every
 * device keeps its own settings exactly as before. */

const DELIVERY_MODES = new Set(['STABLE', 'BALANCED', 'CREATIVE']);
const AGENT_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DELIVERY_KEYS = 200;
const PACE_MIN = 0.5;
const PACE_MAX = 1.5;

function listenerPrefsOn() {
  return process.env.KADE_LISTENER_PREFS !== '0';
}

function iso(value) {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The stored row as clients see it. Fields never written are left out. */
function toListenerJson(row) {
  const out = { delivery: {} };
  if (!row || typeof row !== 'object') {
    return out;
  }
  if (row.paceAt) {
    out.pace = typeof row.pace === 'number' && Number.isFinite(row.pace) ? row.pace : null;
    out.paceAt = iso(row.paceAt);
  }
  if (row.fillersAt && typeof row.fillers === 'boolean') {
    out.fillers = row.fillers;
    out.fillersAt = iso(row.fillersAt);
  }
  const delivery = row.delivery instanceof Map ? Object.fromEntries(row.delivery) : row.delivery;
  if (delivery && typeof delivery === 'object') {
    for (const [agentId, mode] of Object.entries(delivery)) {
      if (AGENT_KEY.test(agentId) && DELIVERY_MODES.has(mode)) {
        out.delivery[agentId] = mode;
      }
    }
  }
  if (row.deliveryAt) {
    out.deliveryAt = iso(row.deliveryAt);
  }
  return out;
}

/**
 * Turns a request body into a Mongo update. Returns { update, errors, changed }.
 * `changed` is false when the body held nothing usable (the caller answers 400).
 */
function buildUpdate(body, now = new Date()) {
  const set = {};
  const unset = {};
  const errors = [];
  const src = body && typeof body === 'object' ? body : {};

  if (Object.prototype.hasOwnProperty.call(src, 'pace')) {
    const pace = src.pace;
    if (pace === null) {
      set.pace = null;
      set.paceAt = now;
    } else if (typeof pace === 'number' && Number.isFinite(pace) && pace >= PACE_MIN && pace <= PACE_MAX) {
      set.pace = Math.round(pace * 100) / 100;
      set.paceAt = now;
    } else {
      errors.push('pace');
    }
  }

  if (Object.prototype.hasOwnProperty.call(src, 'fillers')) {
    if (typeof src.fillers === 'boolean') {
      set.fillers = src.fillers;
      set.fillersAt = now;
    } else {
      errors.push('fillers');
    }
  }

  if (Object.prototype.hasOwnProperty.call(src, 'delivery')) {
    const delivery = src.delivery;
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      errors.push('delivery');
    } else {
      const entries = Object.entries(delivery).slice(0, MAX_DELIVERY_KEYS);
      let any = false;
      for (const [agentId, mode] of entries) {
        if (!AGENT_KEY.test(agentId)) {
          errors.push(`delivery.${String(agentId).slice(0, 64)}`);
          continue;
        }
        if (mode === null || mode === '') {
          unset[`delivery.${agentId}`] = '';
          any = true;
        } else if (typeof mode === 'string' && DELIVERY_MODES.has(mode)) {
          set[`delivery.${agentId}`] = mode;
          any = true;
        } else {
          errors.push(`delivery.${agentId}`);
        }
      }
      if (any) {
        set.deliveryAt = now;
      }
    }
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  return { update, errors, changed: Object.keys(set).length > 0 || Object.keys(unset).length > 0 };
}

/**
 * Handlers for the voice-prefs route. `store` is { getVoicePrefs(userId), getListener(userId),
 * updateListener(userId, update) } so tests can run without a database.
 */
function createListenerPrefsHandlers(store, logger = console) {
  async function getPrefs(req, res) {
    try {
      const prefs = await store.getVoicePrefs(req.user.id);
      if (!listenerPrefsOn()) {
        return res.json({ prefs });
      }
      let listener;
      try {
        listener = toListenerJson(await store.getListener(req.user.id));
      } catch (e) {
        // The voice map must still load; the devices keep their own settings this time.
        logger.warn('[kade/voice-prefs] listener read failed:', e && e.message);
      }
      return res.json(listener ? { prefs, listener } : { prefs });
    } catch (e) {
      logger.error('[kade/voice-prefs] get failed:', e);
      return res.status(500).json({ error: 'Could not load voice preferences' });
    }
  }

  async function putListener(req, res, bodyOverride) {
    if (!listenerPrefsOn()) {
      return res.status(404).json({ error: 'Listener settings sync is off' });
    }
    try {
      const { update, errors, changed } = buildUpdate(bodyOverride || req.body);
      if (!changed) {
        return res.status(400).json({ error: 'Nothing to save', fields: errors });
      }
      const row = await store.updateListener(req.user.id, update);
      return res.json({ ok: true, listener: toListenerJson(row), ...(errors.length ? { refused: errors } : {}) });
    } catch (e) {
      logger.error('[kade/voice-prefs] listener save failed:', e);
      return res.status(500).json({ error: 'Could not save voice settings' });
    }
  }

  return { getPrefs, putListener };
}

module.exports = {
  DELIVERY_MODES,
  listenerPrefsOn,
  toListenerJson,
  buildUpdate,
  createListenerPrefsHandlers,
};
