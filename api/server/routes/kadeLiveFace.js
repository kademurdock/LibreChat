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
 *   POST /api/kade/live-face/admin/face {agentId, faceId}  machine: record a finished face
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
const fs = require('node:fs');
const path = require('node:path');
const { logKadeUsage, RATES } = require('~/models/kadeUsage');
const { getSight, setSight } = require('~/models/kadeSight');
const registry = require('~/models/kadeLiveFaceRegistry');
const sessions = require('~/models/kadeLiveFaceSession');
const { userPriceFactor, isAdminRole } = require('~/server/services/kadeRealCost');
const paths = require('~/config/paths');
const { parseFaces, decide } = require('./LiveFace/policy');
const { liveFaceHtml } = require('./LiveFace/pages');

const router = express.Router();

const SIMLI_API = process.env.SIMLI_API_URL || 'https://api.simli.ai';
const SIMLI_WS = process.env.SIMLI_WS_URL || 'wss://api.simli.ai';
const MAX_SESSION_SECONDS = Math.max(60, Number(process.env.SIMLI_MAX_SESSION_SECONDS) || 1800);
const MAX_IDLE_SECONDS = Math.max(15, Number(process.env.SIMLI_MAX_IDLE_SECONDS) || 120);
/* Simli self-serve, Oct 2026: $0.01 a minute of session (less at volume).
 * One number: RATES.live_face, which an env value (0 allowed) may override. */
const ENV_RATE = Number(process.env.SIMLI_USD_PER_MINUTE);
const USD_PER_MINUTE = process.env.SIMLI_USD_PER_MINUTE !== undefined && Number.isFinite(ENV_RATE) && ENV_RATE >= 0
  ? ENV_RATE
  : (RATES && Number.isFinite(RATES.live_face) ? RATES.live_face : 0.01);
/* Sessions a person may open in an hour: a page flipping between chats opens
 * one each time; sixty is far above any real use and stops a loop billing. */
const MINTS_PER_HOUR = Math.max(1, Number(process.env.SIMLI_MINTS_PER_HOUR) || 60);
/* Face builds a non-admin may start in a day; the plan caps the account. */
const BUILDS_PER_DAY = Math.max(0, Number(process.env.SIMLI_BUILDS_PER_DAY) || 2);
const FETCH_TIMEOUT_MS = 20000;

class PersonError extends Error {}

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

/* usdPerMinute is what THIS person's balance pays (0 for the administrator,
 * the platform factor x the real cost for everyone else); realUsdPerMinute
 * is the service's own price. */
router.get('/live-face/config', requireJwtAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const all = await faces();
  const charged = isAdminRole(req.user && req.user.role) ? 0 : USD_PER_MINUTE * userPriceFactor(req.user);
  res.json({
    enabled: configured() && Object.keys(all).length > 0,
    agents: Object.keys(all),
    usdPerMinute: Number(charged.toFixed(4)),
    realUsdPerMinute: USD_PER_MINUTE,
  });
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
    const recent = await sessions.mintedSince(req.user.id, new Date(Date.now() - 3600 * 1000));
    if (recent >= MINTS_PER_HOUR) {
      return res.status(429).json({ error: 'Live faces are resting for a little while. The painted face carries on.', code: 'rate' });
    }
    const r = await fetch(SIMLI_API + '/compose/token', {
      method: 'POST',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    const sessionId = await sessions.mint({
      userId: req.user.id,
      agentId,
      lane,
      faceId: verdict.faceId,
      ceilingSeconds: MAX_SESSION_SECONDS,
    });
    logger.info(`[kade/live-face] session ${sessionId} for ${req.user.id} ${agentId} (${lane})`);
    res.json({
      sessionId,
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

/* The client says how long a session ran. It must name a session this
 * server minted for this person; the row is settled once, and the seconds
 * are capped by the server's own clock (now - mintedAt) and the ceiling, so
 * a client can neither invent minutes nor bill a session that never was.
 * The row lands with the rest of the person's spend (admin sees real cost,
 * others their price). */
router.post('/live-face/usage', requireJwtAuth, express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const settled = await sessions.settle({ sessionId: b.sessionId, userId: req.user.id, claimedSeconds: b.seconds });
    if (!settled) return res.status(404).json({ error: 'No open session to settle.' });
    const seconds = settled.seconds;
    if (seconds < 1) return res.json({ ok: true, minutes: 0 });
    const minutes = Math.round((seconds / 60) * 1000) / 1000;
    await logKadeUsage({
      userId: req.user.id,
      service: 'live_face',
      quantity: minutes,
      unit: 'minute',
      costUSD: minutes * USD_PER_MINUTE,
      metadata: {
        agentId: settled.row.agentId,
        lane: settled.row.lane,
        sessionId: String(settled.row._id),
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

const MAX_PORTRAIT_BYTES = 5 * 1024 * 1024;

/* The character's portrait as bytes. A local avatar (/images/...) is read
 * from the image folder on disk (the /images route needs a cookie the
 * server does not have); an S3 avatar is fetched through a fresh presigned
 * URL. Nothing else is ever fetched, so an avatar path cannot point the
 * server at an arbitrary address. */
async function portraitBytes(agent) {
  if (!agent || !agent.avatar || !agent.avatar.filepath) return null;
  const filepath = String(agent.avatar.filepath);
  if (agent.avatar.source === FileSources.s3) {
    let url;
    try {
      url = await refreshS3Url(agent.avatar);
    } catch (e) {
      logger.warn(`[kade/live-face] avatar refresh failed: ${e.message}`);
      return null;
    }
    if (!/^https:\/\//i.test(String(url || ''))) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new PersonError('The portrait could not be fetched.');
    const declared = Number(r.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PORTRAIT_BYTES) throw new PersonError('The portrait is over 5 MB; a smaller picture is needed.');
    const bytes = Buffer.from(await r.arrayBuffer());
    return { bytes, type: r.headers.get('content-type') || 'image/png', ref: filepath.split('?')[0] };
  }
  if (!filepath.includes('/images/')) return null;
  const base = filepath.split('/images/')[1].split('?')[0];
  const dir = paths.imageOutput;
  const full = path.join(dir, base);
  const rel = path.relative(dir, full);
  if (!base || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const stat = await fs.promises.stat(full).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  if (stat.size > MAX_PORTRAIT_BYTES) throw new PersonError('The portrait is over 5 MB; a smaller picture is needed.');
  const ext = path.extname(full).toLowerCase();
  const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return { bytes: await fs.promises.readFile(full), type, ref: filepath };
}

/* Preprocess (reframe) then build. Returns {faceId, warnings, dispatchAfter};
 * throws PersonError with words for the person, anything else is logged. */
async function buildFace(picture, name) {
  const key = process.env.SIMLI_API_KEY;
  const { bytes, type } = picture;
  if (bytes.length > MAX_PORTRAIT_BYTES) throw new PersonError('The portrait is over 5 MB; a smaller picture is needed.');
  const form = new FormData();
  form.append('image', new Blob([bytes], { type }), 'portrait.png');
  const pre = await fetch(SIMLI_API + '/faces/trinity/preprocess?gsVersion=GSA_2.0', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: { 'x-simli-api-key': key },
    body: form,
  });
  if (pre.status === 403) throw new PersonError('No face builds are left on the plan this month.');
  if (!pre.ok) {
    const text = (await pre.text()).slice(0, 300);
    logger.warn(`[kade/live-face] preprocess ${pre.status}: ${text}`);
    throw new PersonError('The face service could not use this portrait (it needs one person facing the camera).');
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
    signal: AbortSignal.timeout(90000),
    headers: { 'x-simli-api-key': key, 'target-ratio': String(ratio) },
    body: form2,
  });
  if (made.status === 403) throw new PersonError('No face builds are left on the plan this month.');
  const text = await made.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch (_) {
    j = null;
  }
  if (!made.ok || !j || !j.face_id) {
    logger.warn(`[kade/live-face] build ${made.status}: ${text.slice(0, 300)}`);
    throw new PersonError('The face service did not accept the build.');
  }
  return { faceId: String(j.face_id), warnings: warnings.concat(j.warnings || []), dispatchAfter: j.dispatch_after };
}

/* Ask the service where a queued face stands; update the row when it moved. */
async function refreshFace(row) {
  if (!row || !['pending', 'processing'].includes(row.status)) return row;
  try {
    const r = await fetch(SIMLI_API + '/faces/trinity/generation_status?face_id=' + encodeURIComponent(row.faceId || ''), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
      const list = await fetch(SIMLI_API + '/faces', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'x-simli-api-key': process.env.SIMLI_API_KEY } });
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
    const admin = isAdminRole(req.user && req.user.role);
    // A finished face is rebuilt only by the administrator; anyone may retry a failed one.
    if (existing && existing.status === 'completed' && !(admin && (req.body || {}).again)) {
      return res.json({ ok: true, ...existing });
    }
    if (!admin) {
      const today = await registry.requestsSince(req.user.id, new Date(Date.now() - 24 * 3600 * 1000));
      if (today >= BUILDS_PER_DAY) {
        return res.status(429).json({ error: 'You can bring ' + BUILDS_PER_DAY + ' characters to life a day. Try again tomorrow.' });
      }
    }
    const agent = await getAgent({ id: agentId }).catch(() => null);
    const picture = await portraitBytes(agent);
    if (!picture) return res.status(400).json({ error: 'This character has no portrait to work from.' });
    const built = await buildFace(picture, agent.name);
    const row = await registry.recordRequest(agentId, { ...built, requestedBy: req.user.id, portrait: picture.ref });
    logger.info(`[kade/live-face] face queued for ${agentId} by ${req.user.id}: ${built.faceId}`);
    res.json({ ok: true, ...row, note: 'Queued. A live face takes about four hours to build; the painted face carries on meanwhile.' });
  } catch (e) {
    logger.warn('[kade/live-face] bring to life failed: ' + (e && e.message));
    const words = e instanceof PersonError ? e.message : 'The face could not be started.';
    res.status(e instanceof PersonError ? 400 : 500).json({ error: words });
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

/* Machine route: record a face built outside the app (Kade's main cast,
 * built through the face API by hand) as completed, so it opens live with no
 * redeploy. Same trust as /usage-event: KADE_USAGE_EVENT_SECRET in the
 * x-kade-secret header, compared in constant time. faceId null removes it. */
router.post('/live-face/admin/face', express.json({ limit: '2kb' }), async (req, res) => {
  try {
    const expected = process.env.KADE_USAGE_EVENT_SECRET || '';
    const given = String(req.get('x-kade-secret') || '');
    const crypto = require('node:crypto');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    const agentId = String((req.body || {}).agentId || '').slice(0, 64);
    const faceId = (req.body || {}).faceId;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    if (!faceId) {
      await registry.KadeLiveFace.deleteOne({ agentId });
      return res.json({ ok: true, agentId, removed: true });
    }
    await registry.recordRequest(agentId, { faceId: String(faceId).slice(0, 120), requestedBy: 'admin', portrait: 'by hand' });
    const row = await registry.recordStatus(agentId, 'completed', { error: null });
    logger.info(`[kade/live-face] admin set face for ${agentId}`);
    res.json({ ok: true, ...row });
  } catch (e) {
    logger.error('[kade/live-face] admin face failed:', e);
    res.status(500).json({ error: 'Could not record the face.' });
  }
});

router.page = (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(liveFaceHtml);
router.faces = { buildFace, refreshFace, portraitBytes };
router.policy = { parseFaces, decide };

module.exports = router;
