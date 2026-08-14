const axios = require('axios');
const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { KadeAccessRequest } = require('~/models/kadeAccessRequest');

const router = express.Router();

/**
 * PUBLIC doorbell (Aug 9 2026): POST /api/access-request — no auth, because
 * the whole point is people who don't have accounts yet. Defenses instead:
 * per-IP cooldown (3/hour, in-memory), a honeypot field bots love, hard
 * length caps, and the request only ever RINGS Kade — nothing self-serves.
 */
const recent = new Map(); // ip -> [timestamps]
function ipAllowed(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= 3) return false;
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear(); // never let the map become a leak
  return true;
}

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    /* Honeypot: real people never see this field; bots autofill it. */
    if (b.website) return res.json({ ok: true });
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    if (!ipAllowed(ip)) {
      return res.status(429).json({ error: 'Easy now — that door was just knocked on. Try again in a bit.' });
    }
    const name = String(b.name || '').trim().slice(0, 80);
    const contact = String(b.contact || '').trim().slice(0, 160);
    const whoYouAre = String(b.whoYouAre || '').trim().slice(0, 1200);
    const whyHere = String(b.whyHere || '').trim().slice(0, 1200);
    if (!name || !contact || !whoYouAre) {
      return res.status(400).json({ error: 'Name, a way to reach you, and who you are — those three are the whole ask.' });
    }
    const doc = await KadeAccessRequest.create({ name, contact, whoYouAre, whyHere, ip });
    /* Ring her phone — REBUILT Aug 13 2026 night, after her own test knock at
     * 9:22 PM was silently eaten. Three faults in the original, each the
     * blocked-means-lost disease:
     *  (1) It rode the AGENT-scoped lane, so the owner's doorbell bowed to the
     *      agents' shared 30-min cooldown and daily caps — a noon knock could
     *      vanish because some character pinged recently. Now BRIDGE_SECRET +
     *      adminAlert, the owner-alert lane every other owner ping uses.
     *  (2) Not urgent, so quiet hours refused it — which is exactly how her
     *      test died. HER CALL, on the record: the doorbell always rings.
     *      There is a live person standing at the door; unlike a crash
     *      report, they may walk off. urgent:true.
     *  (3) Push-only. A refused push was GONE — nothing else carried the
     *      knock. Now a chat nudge is queued FIRST (kadeOwnerAlerts' exact
     *      both-channels pattern), so even if APNs itself hiccups, whoever
     *      she talks to next says someone's at the door.
     * Still fail-soft throughout: the request document is already saved
     * before any of this runs, and a delivery failure never breaks the
     * visitor's submission. */
    const adminId = process.env.ADMIN_USER_ID || '6a3cba4d0b0afa92194e42f7';
    try {
      const { KadePendingNudge } = require('~/models/kadeNudge');
      await KadePendingNudge.create({
        userId: adminId,
        text: `Someone knocked at the front door: ${name} — "${whoYouAre.slice(0, 120)}". Review under You, then Access Requests.`,
        type: 'access-request',
        channel: 'chat',
      });
    } catch (nudgeErr) {
      logger.warn('[access-request] chat nudge failed (request saved fine):', nudgeErr.message);
    }
    try {
      const bridgeUrl = process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app';
      const secret = process.env.BRIDGE_SECRET || process.env.NOTIFY_AGENT_SECRET || '';
      const r = await axios.post(
        `${bridgeUrl}/notify`,
        {
          secret,
          agentId: 'kade-access-request',
          agentName: 'Front door',
          title: 'Someone is asking in',
          body: `${name}: "${whoYouAre.slice(0, 140)}" — review under You, then Access Requests.`,
          userId: adminId,
          urgent: true,
          adminAlert: true,
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 8000 },
      );
      const out = r && r.data ? r.data : {};
      /* The receipt, in the log, every time — sent, blocked, or zero-target.
       * A doorbell that fails silently is a wall. */
      logger.info(
        `[access-request] doorbell push: sent=${out.sent ?? '?'}${out.blocked ? ` blocked=${out.blocked}` : ''}`,
      );
    } catch (e) {
      logger.warn('[access-request] doorbell push failed (request saved fine):', e.message);
    }
    logger.info(`[access-request] new request from "${name}" (${doc._id})`);
    res.json({ ok: true, message: 'Request sent. If Kade knows you, expect to hear back soon — she gets it on her phone.' });
  } catch (error) {
    logger.error('[access-request] failed', error);
    res.status(500).json({ error: 'The doorbell jammed — try again in a minute.' });
  }
});

module.exports = router;
