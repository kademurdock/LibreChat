/**
 * Oct 28 2026 — LIVE VIDEO FACES (Kade: "like Marco Polo or WhatsApp where
 * for sighted people, listening to a voice message would trigger a video...
 * and calls would be video calls... for blind people, we could turn it off
 * to save money").
 *
 * Simli renders a character's painting live from the audio it is given
 * (about a cent a minute, their self-serve rate, Oct 2026). This router:
 *   GET  /api/kade/sight              {sight, liveFaces}  the account's flag
 *   PUT  /api/kade/sight              {sight?, liveFaces?}
 *   GET  /api/kade/live-face/config   {enabled, agents:[ids]} who has a face
 *   POST /api/kade/live-face/session  {agentId, lane} -> {sessionToken, ws, maxSessionLength}
 *   POST /api/kade/live-face/usage    {seconds, agentId, lane} usage row
 *   GET  /live-face                   the page a client loads (LiveFace/page.*)
 *
 * Env: SIMLI_API_KEY; SIMLI_FACES = {"agent_id":"faceId",...} (Kiana and
 * Harley first; add a character by adding its id). Nothing here runs for a
 * blind account: LiveFace/policy.js is the one gate, and it is tested.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const { logKadeUsage } = require('~/models/kadeUsage');
const { getSight, setSight } = require('~/models/kadeSight');
const { parseFaces, decide } = require('./LiveFace/policy');
const { liveFaceHtml } = require('./LiveFace/pages');

const router = express.Router();

const SIMLI_API = process.env.SIMLI_API_URL || 'https://api.simli.ai';
const SIMLI_WS = process.env.SIMLI_WS_URL || 'wss://api.simli.ai';
const MAX_SESSION_SECONDS = Math.max(60, Number(process.env.SIMLI_MAX_SESSION_SECONDS) || 1800);
const MAX_IDLE_SECONDS = Math.max(15, Number(process.env.SIMLI_MAX_IDLE_SECONDS) || 120);
/* Simli self-serve, Oct 2026: $0.01 a minute of session (less at volume). */
const USD_PER_MINUTE = Number(process.env.SIMLI_USD_PER_MINUTE) || 0.01;

function faces() {
  return parseFaces(process.env.SIMLI_FACES);
}
function configured() {
  return Boolean(process.env.SIMLI_API_KEY && Object.keys(faces()).length);
}

router.get('/sight', requireJwtAuth, async (req, res) => {
  try {
    res.json(await getSight(req.user.id));
  } catch (e) {
    logger.error('[kade/sight] read failed:', e);
    res.status(500).json({ error: 'Could not read your screen setting.' });
  }
});

router.put('/sight', requireJwtAuth, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if ('sight' in b) patch.sight = b.sight === null || b.sight === '' ? null : String(b.sight);
    if ('liveFaces' in b) patch.liveFaces = Boolean(b.liveFaces);
    res.json({ ok: true, ...(await setSight(req.user.id, patch, 'user')) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/live-face/config', requireJwtAuth, async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ enabled: configured(), agents: Object.keys(faces()), usdPerMinute: USD_PER_MINUTE });
});

router.post('/live-face/session', requireJwtAuth, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const agentId = String((req.body || {}).agentId || '').slice(0, 64);
    const lane = String((req.body || {}).lane || 'chat').slice(0, 16);
    const sight = await getSight(req.user.id);
    const verdict = decide({
      configured: configured(),
      faces: faces(),
      agentId,
      sight: sight.sight,
      liveFaces: sight.liveFaces,
    });
    if (!verdict.ok) {
      return res
        .status(verdict.code === 'unconfigured' ? 503 : 403)
        .json({ error: verdict.reason, code: verdict.code });
    }
    const r = await fetch(SIMLI_API + '/compose/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-simli-api-key': process.env.SIMLI_API_KEY },
      body: JSON.stringify({
        faceId: verdict.faceId,
        handleSilence: true,
        maxSessionLength: MAX_SESSION_SECONDS,
        maxIdleTime: MAX_IDLE_SECONDS,
      }),
    });
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch (_) {
      j = null;
    }
    const sessionToken = j && (j.session_token || j.sessionToken);
    if (!r.ok || !sessionToken) {
      logger.warn(`[kade/live-face] token refused ${r.status}: ${text.slice(0, 200)}`);
      return res.status(502).json({ error: 'The live face could not be started right now.' });
    }
    logger.info(`[kade/live-face] session for ${req.user.id} ${agentId} (${lane})`);
    res.json({
      sessionToken,
      ws: SIMLI_WS,
      maxSessionLength: MAX_SESSION_SECONDS,
      maxIdleTime: MAX_IDLE_SECONDS,
      warnings: (j && j.warnings) || [],
    });
  } catch (e) {
    logger.error('[kade/live-face] session failed:', e);
    res.status(500).json({ error: 'The live face could not be started right now.' });
  }
});

/* The client says how long a session ran; the row lands with the rest of
 * the person's spend (admin sees real cost, others their price). Seconds
 * are capped at the session ceiling so a bad clock cannot invent an hour. */
router.post('/live-face/usage', requireJwtAuth, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const seconds = Math.min(MAX_SESSION_SECONDS, Math.max(0, Number(b.seconds) || 0));
    if (seconds < 1) return res.json({ ok: true, minutes: 0 });
    const minutes = Math.round((seconds / 60) * 1000) / 1000;
    await logKadeUsage({
      userId: req.user.id,
      service: 'live_face',
      quantity: minutes,
      unit: 'minute',
      costUSD: minutes * USD_PER_MINUTE,
      metadata: {
        agentId: String(b.agentId || '').slice(0, 64),
        lane: String(b.lane || '').slice(0, 16),
        seconds,
      },
    });
    res.json({ ok: true, minutes });
  } catch (e) {
    logger.error('[kade/live-face] usage failed:', e);
    res.status(500).json({ error: 'Could not record the session.' });
  }
});

router.page = (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(liveFaceHtml);
router.policy = { parseFaces, decide };

module.exports = router;
