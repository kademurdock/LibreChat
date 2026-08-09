const axios = require('axios');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');

const router = express.Router();

/**
 * Aug 9 2026 — MORNING BRIEF settings lane (her spec: per account, in
 * settings, delivered by your own companion, checkboxes for content, your
 * own town's weather). The bridge owns prefs/schedules/composition; this
 * lane is the ONLY user-facing writer, and it hard-binds every call to the
 * JWT user — a signed-in person can only ever see or change their own
 * brief. The bridge secret never leaves the server.
 *
 * GET  /            -> { prefs, linked, lastBrief }
 * POST /            -> save prefs (enabled, time, items, location, agentId)
 * POST /fire        -> send one right now (the settings page's test button)
 */
router.use(requireJwtAuth);

const BRIDGE_URL = process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app';
const SECRET = process.env.NOTIFY_AGENT_SECRET || process.env.BRIDGE_SECRET || '';

function bridgeHeaders() {
  return { 'x-notify-secret': SECRET, 'Content-Type': 'application/json' };
}

router.get('/', async (req, res) => {
  try {
    const [prefsR, todayR] = await Promise.all([
      axios.get(`${BRIDGE_URL}/brief-prefs?userId=${encodeURIComponent(req.user.id)}`, { headers: bridgeHeaders(), timeout: 8000 }),
      axios.get(`${BRIDGE_URL}/brief/today?userId=${encodeURIComponent(req.user.id)}`, { headers: bridgeHeaders(), timeout: 8000 }),
    ]);
    res.json({ ...prefsR.data, lastBrief: todayR.data.lastBrief || prefsR.data.lastBrief || null });
  } catch (error) {
    logger.error('[brief] prefs fetch failed', error.message);
    res.status(502).json({ error: 'Could not reach the brief service just now' });
  }
});

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const payload = {
      userId: String(req.user.id),
      email: req.user.email || undefined,
      enabled: b.enabled,
      time: b.time,
      items: b.items,
      location: b.location,
      agentId: b.agentId,
    };
    const r = await axios.post(`${BRIDGE_URL}/brief-prefs`, payload, { headers: bridgeHeaders(), timeout: 8000 });
    res.json(r.data);
  } catch (error) {
    logger.error('[brief] prefs save failed', error.message);
    res.status(502).json({ error: 'Could not save just now — try again in a moment' });
  }
});

router.post('/fire', async (req, res) => {
  try {
    const r = await axios.post(
      `${BRIDGE_URL}/brief/fire`,
      { userId: String(req.user.id) },
      { headers: bridgeHeaders(), timeout: 150000 },
    );
    res.json(r.data);
  } catch (error) {
    logger.error('[brief] test fire failed', error.message);
    res.status(502).json({ error: 'Could not send a test brief just now' });
  }
});

module.exports = router;
