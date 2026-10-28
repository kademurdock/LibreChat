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
 *   POST /api/kade/live-face/faces/:agentId   bring a character to life from its portrait
 *   GET  /api/kade/live-face/faces/:agentId   where that stands (pending/processing/completed/failed)
 *   GET  /live-face                   the page a client loads (LiveFace/page.*)
 *
 * Env: SIMLI_API_KEY; SIMLI_FACES = {"agent_id":"faceId",...} (Kiana and
 * Harley by hand). Every other character comes through the registry
 * (kadeLiveFaceRegistry): its owner asks, the portrait goes to the face
 * service (preprocess, then build; about four hours), and once completed
 * the character opens live like the first two. Nothing here runs for a
 * blind account: LiveFace/policy.js is the one gate, and it is tested.
 */
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { PermissionBits, FileSources } = require('librechat-data-provider');
const { refreshS3Url } = require('@librechat/api');
const { requireJwtAuth, canAccessAgentResource } = require('~/server/middleware');
const { getAgent } = require('~/models');
const { logKadeUsage } = require('~/models/kadeUsage');
const { getSight, setSight } = require('~/models/kadeSight');
const registry = require('~/models/kadeLiveFaceRegistry');
const { parseFaces, decide } = require('./LiveFace/policy');
const { liveFaceHtml } = require('./LiveFace/pages');

const router = express.Router();

const SIMLI_API = process.env.SIMLI_API_URL || 'https://api.simli.ai';
const SIMLI_WS = process.env.SIMLI_WS_URL || 'wss://api.simli.ai';
const MAX_SESSION_SECONDS = Math.max(60, Number(process.env.SIMLI_MAX_SESSION_SECONDS) || 1800);
const MAX_IDLE_SECONDS = Math.max(15, Number(process.env.SIMLI_MAX_IDLE_SECONDS) || 120);
/* Simli self-serve, Oct 2026: $0.01 a minute of session (less at volume). */
const USD_PER_MINUTE = Number(process.env.SIMLI_USD_PER_MINUTE) || 0.01;

function envFaces() {
  return parseFaces(process.env.SIMLI_FACES);
}
/* Hand-made faces plus every finished registry face. The registry read is
 * fail-soft: a database hiccup leaves the hand-made two working. */
async function faces() {
  let built = {};
  try {
    built = await registry.completedFaces();
  } catch (e) {
    logger.warn('[kade/live-face] registry read failed: ' + e.message);
  }
  return registry.mergeFaces(envFaces(), built);
}
function configured() {
  return Boolean(process.env.SIMLI_API_KEY);
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
  const all = await faces();
  res.json({ enabled: configured() && Object.keys(all).length > 0, agents: Object.keys(all), usdPerMinute: USD_PER_MINUTE });
});

router.post('/live-face/session', requireJwtAuth, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const agentId = String((req.body || {}).agentId || '').slice(0, 64);
    const lane = String((req.body || {}).lane || 'chat').slice(0, 16);
    const sight = await getSight(req.user.id);
    const all = await faces();
    const verdict = decide({
      configured: configured() && Object.keys(all).length > 0,
      faces: all,
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

/* ------------------------------------------------------------------------
 * Bringing a builder character to life. The owner (or anyone who may edit
 * the character) asks once; the portrait is reframed by the service, the
 * face is queued, and the row waits in the registry. Later reads poll the
 * service until it says completed or failed. The service refuses pictures
 * without a camera-facing person (a head under 15% of the height), which is
 * also our creature check: Diggy the dog never gets a live face.
 * ---------------------------------------------------------------------- */
const canEditAgent = canAccessAgentResource({ requiredPermission: PermissionBits.EDIT, resourceIdParam: 'agentId' });
const canViewAgent = canAccessAgentResource({ requiredPermission: PermissionBits.VIEW, resourceIdParam: 'agentId' });
const FACE_CHECK_EVERY_MS = 5 * 60 * 1000;

async function portraitURL(agent) {
  if (!agent || !agent.avatar || !agent.avatar.filepath) return null;
  let url = agent.avatar.filepath;
  if (agent.avatar.source === FileSources.s3) {
    try {
      url = await refreshS3Url(agent.avatar);
    } catch (e) {
      logger.warn(`[kade/live-face] avatar refresh failed: ${e.message}`);
    }
  }
  if (/^\/images\//.test(String(url))) url = (process.env.DOMAIN_SERVER || 'https://kademurdock.com') + url;
  return /^https?:\/\//i.test(String(url)) ? String(url) : null;
}

/* Preprocess (reframe) then build. Returns {faceId, warnings, dispatchAfter} or throws a message for the person. */
async function buildFace(portrait, name) {
  const key = process.env.SIMLI_API_KEY;
  const picture = await fetch(portrait);
  if (!picture.ok) throw new Error('The portrait could not be fetched.');
  const bytes = Buffer.from(await picture.arrayBuffer());
  if (bytes.length > 5 * 1024 * 1024) throw new Error('The portrait is over 5 MB; a smaller picture is needed.');
  const type = picture.headers.get('content-type') || 'image/png';
  const form = new FormData();
  form.append('image', new Blob([bytes], { type }), 'portrait.png');
  const pre = await fetch(SIMLI_API + '/faces/trinity/preprocess?gsVersion=GSA_2.0', {
    method: 'POST',
    headers: { 'x-simli-api-key': key },
    body: form,
  });
  if (pre.status === 403) throw new Error('No face builds are left on the plan this month.');
  if (!pre.ok) {
    const text = (await pre.text()).slice(0, 300);
    logger.warn(`[kade/live-face] preprocess ${pre.status}: ${text}`);
    throw new Error('The face service could not use this portrait (it needs one person facing the camera).');
  }
  const framed = Buffer.from(await pre.arrayBuffer());
  const ratio = pre.headers.get('target-ratio') || '0';
  let warnings = [];
  try {
    warnings = JSON.parse(pre.headers.get('warnings') || '[]');
  } catch (_) {
    warnings = [];
  }
  const form2 = new FormData();
  form2.append('image', new Blob([framed], { type: 'image/png' }), 'framed.png');
  const safeName = String(name || 'character').replace(/[^\w\- ]+/g, '').trim().slice(0, 40) || 'character';
  const made = await fetch(SIMLI_API + '/faces/trinity?gsVersion=GSA_2.0&face_name=' + encodeURIComponent(safeName), {
    method: 'POST',
    headers: { 'x-simli-api-key': key, 'target-ratio': String(ratio) },
    body: form2,
  });
  if (made.status === 403) throw new Error('No face builds are left on the plan this month.');
  const text = await made.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch (_) {
    j = null;
  }
  if (!made.ok || !j || !j.face_id) {
    logger.warn(`[kade/live-face] build ${made.status}: ${text.slice(0, 300)}`);
    throw new Error('The face service did not accept the build.');
  }
  return { faceId: String(j.face_id), warnings: warnings.concat(j.warnings || []), dispatchAfter: j.dispatch_after };
}

/* Ask the service where a queued face stands; update the row when it moved. */
async function refreshFace(row) {
  if (!row || !['pending', 'processing'].includes(row.status)) return row;
  try {
    const r = await fetch(SIMLI_API + '/faces/trinity/generation_status?face_id=' + encodeURIComponent(row.faceId || ''), {
      headers: { 'x-simli-api-key': process.env.SIMLI_API_KEY },
    });
    if (!r.ok) return row;
    const j = await r.json();
    const mine = (j.generations || []).find((g) => g.face_id === row.faceId) || j;
    const status = String(mine.status || '');
    if (['completed', 'failed', 'processing', 'pending'].includes(status)) {
      return registry.recordStatus(row.agentId, status, {
        error: status === 'failed' ? 'The face service could not build this face.' : null,
        dispatchAfter: mine.dispatch_after,
      });
    }
    if (status === 'not_found') {
      // Finished generations leave the list after a day: a face the account
      // owns by then is completed; otherwise the build is lost.
      const list = await fetch(SIMLI_API + '/faces', { headers: { 'x-simli-api-key': process.env.SIMLI_API_KEY } });
      const owned = list.ok ? await list.json() : [];
      const found = Array.isArray(owned) && owned.some((f) => f && f.id === row.faceId);
      return registry.recordStatus(row.agentId, found ? 'completed' : 'failed', {
        error: found ? null : 'The face build was not found at the service.',
      });
    }
  } catch (e) {
    logger.warn('[kade/live-face] status check failed: ' + e.message);
  }
  return row;
}

router.post('/live-face/faces/:agentId', requireJwtAuth, canEditAgent, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    if (!configured()) return res.status(503).json({ error: 'Live faces are not set up on this server yet.' });
    const agentId = String(req.params.agentId).slice(0, 64);
    if (envFaces()[agentId]) return res.json({ ok: true, agentId, status: 'completed', handMade: true });
    const existing = await registry.getFace(agentId);
    if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
      return res.json({ ok: true, ...existing, note: 'Already being built; it takes a few hours.' });
    }
    if (existing && existing.status === 'completed' && !(req.body || {}).again) {
      return res.json({ ok: true, ...existing });
    }
    const agent = await getAgent({ id: agentId }).catch(() => null);
    const portrait = await portraitURL(agent);
    if (!portrait) return res.status(400).json({ error: 'This character has no portrait to work from.' });
    const built = await buildFace(portrait, agent.name);
    const row = await registry.recordRequest(agentId, { ...built, requestedBy: req.user.id, portrait });
    logger.info(`[kade/live-face] face queued for ${agentId} by ${req.user.id}: ${built.faceId}`);
    res.json({ ok: true, ...row, note: 'Queued. A live face takes about four hours to build; the painted face carries on meanwhile.' });
  } catch (e) {
    logger.warn('[kade/live-face] bring to life failed: ' + e.message);
    res.status(400).json({ error: e.message || 'The face could not be started.' });
  }
});

router.get('/live-face/faces/:agentId', requireJwtAuth, canViewAgent, async (req, res) => {
  try {
    const agentId = String(req.params.agentId).slice(0, 64);
    if (envFaces()[agentId]) return res.json({ agentId, status: 'completed', handMade: true });
    let row = await registry.getFace(agentId);
    if (!row) return res.json({ agentId, status: 'none' });
    const stale = !row.updatedAt || Date.now() - new Date(row.updatedAt).getTime() > FACE_CHECK_EVERY_MS;
    if (stale && configured()) row = await refreshFace(row);
    res.json(row);
  } catch (e) {
    logger.error('[kade/live-face] face read failed:', e);
    res.status(500).json({ error: 'Could not read that face.' });
  }
});

router.page = (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(liveFaceHtml);
router.faces = { buildFace, refreshFace, portraitURL };
router.policy = { parseFaces, decide };

module.exports = router;
