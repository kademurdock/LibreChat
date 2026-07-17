/* Web streaming voice — ticket mint (July 9 2026, duplex workup Track A).
 *
 * GET /api/kade/web-voice/ticket?agentId=agent_xxx   (JWT)
 *   -> { ticket, wsUrl }
 *
 * The ticket is a 2-minute HMAC pass the kade-ai-bridge's /ws/web-voice
 * WebSocket verifies before opening a browser streaming call (the phone
 * engine with a web transport). Signed with the SAME shared secret the
 * bridge already uses for calls/ingest (KADE_CALL_INGEST_SECRET, falling
 * back to KADE_USAGE_EVENT_SECRET) — zero new env vars.
 *
 * It carries who is calling (email/uid/name — Call History attribution +
 * greeting), the child-account flag (the platform-wide invisible clean
 * note applies on web calls exactly like phone), and the agent's builder
 * voice + rate read straight from agent.tts (same fields the debate room
 * uses), so the call greets in the RIGHT voice with no cache warmup race.
 */
const express = require('express');
const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');
const { getUserVoicePref } = require('~/models/kadeVoicePref');

const router = express.Router();

const BRIDGE_WS_URL =
  process.env.KADE_BRIDGE_WS_URL || 'wss://kade-ai-bridge-production.up.railway.app/ws/web-voice';

router.get('/ticket', requireJwtAuth, async (req, res) => {
  try {
    const secret = process.env.KADE_CALL_INGEST_SECRET || process.env.KADE_USAGE_EVENT_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'web voice not configured' });
    }
    const agentId = String(req.query.agentId || '').slice(0, 64) || null;

    let agentName = null;
    let voiceId = null;
    let rate = null;
    if (agentId) {
      try {
        const a = await db.getAgent({ id: agentId });
        if (a) {
          agentName = a.name || null;
          voiceId = (a.tts && a.tts.voiceId) || null;
          const r = a.tts && Number(a.tts.speakingRate);
          rate = Number.isFinite(r) && r > 0 ? r : null;
        }
      } catch (err) {
        logger.warn('[kadeWebVoice] agent lookup failed: ' + err.message);
      }
      /* KADE July 17 2026: the UNIFIED RESOLVER (kadeVoiceResolver.js) now
       * decides the chain — personal pick -> builder -> name-match -> default,
       * live-catalog-validated — so this surface can never drift from the
       * bridge again. Fail-soft: resolver trouble -> the pre-resolver
       * personal-pick override below (the July 12 behavior) still runs. */
      let resolvedBySharedChain = false;
      try {
        const { resolveVoice } = require('~/server/services/kadeVoiceResolver');
        const resolved = await resolveVoice({
          userId: String(req.user.id || req.user._id),
          agentId,
          surface: 'web',
        });
        if (resolved && resolved.voice) {
          voiceId = resolved.voice;
          if (resolved.rate != null) {
            rate = resolved.rate;
          }
          resolvedBySharedChain = true;
          logger.info(
            `[kadeWebVoice] resolver: voice="${resolved.voice}" source=${resolved.source} agent=${agentId}`,
          );
        }
      } catch (err) {
        logger.warn('[kadeWebVoice] unified resolver failed (falling back): ' + err.message);
      }
      /* KADE July 12 2026 (fallback path): the caller's own per-agent voice
       * pick beats the builder default on web calls too — same order the
       * in-app read-aloud resolves (personal -> agent default). Fail-soft. */
      if (!resolvedBySharedChain) {
        try {
          const personal = await getUserVoicePref(String(req.user.id || req.user._id), agentId);
          if (personal) {
            voiceId = personal;
          }
        } catch (err) {
          logger.warn('[kadeWebVoice] voice pref lookup failed (using agent default): ' + err.message);
        }
      }
    }

    let u = req.user || {};
    if (u.kadeAccountType === undefined && u.email) {
      // Some auth strategies project a slim user; the child flag matters
      // (invisible clean note on every call turn), so fetch it if missing.
      try {
        const full = await db.findUser({ email: u.email }, 'email name username kadeAccountType');
        if (full) u = { ...u, kadeAccountType: full.kadeAccountType, name: u.name || full.name };
      } catch { /* slim ticket is still valid */ }
    }

    /* SPOTTER (July 16 2026): the account's personal live companion rides the
     * ticket so the bridge greets live mode with THEIR name/voice/personality.
     * Fail-soft: no spotter row (or lookup trouble) = null = generic Spotter. */
    let spotter = null;
    try {
      const { getSpotter } = require('~/models/kadeSpotter');
      spotter = await getSpotter(String(u.id || u._id || req.user.id || req.user._id));
    } catch (err) {
      logger.warn('[kadeWebVoice] spotter lookup failed (generic live persona): ' + err.message);
    }

    const payload = {
      v: 1,
      spotter,
      email: u.email || null,
      uid: String(u.id || u._id || ''),
      name: u.name || u.username || null,
      accountType: u.kadeAccountType === 'child' ? 'child' : null,
      agentId,
      agentName,
      voiceId,
      rate,
      exp: Date.now() + 120000,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return res.json({ ticket: `${body}.${sig}`, wsUrl: BRIDGE_WS_URL });
  } catch (err) {
    logger.error('[kadeWebVoice] ticket error', err);
    return res.status(500).json({ error: 'ticket failed' });
  }
});

module.exports = router;
