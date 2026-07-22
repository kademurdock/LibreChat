const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');

/**
 * KADE Session 23 — owner alerts for new bug reports.
 *
 * Her ask, verbatim: "Can you make it where I get an in chat reminder or
 * notify or whatever when someone submits a bug report? ... I'd like to
 * personally have a app notification when someone submits a bug."
 *
 * Both channels, deliberately, not deliverNudge's either/or:
 *  (a) IN-CHAT: a pending chat nudge on the owner's account — whichever
 *      persona she talks to next mentions the new report naturally (the
 *      same '# Waiting nudges' rail reminders ride).
 *  (b) APP PUSH: bridge /notify targeted at her LibreChat user id (device
 *      tokens are linked to LibreChat ids — see bridge pushTokens), sent
 *      with adminAlert:true (BRIDGE_SECRET) so owner alerts never eat the
 *      agents' outreach caps/cooldown. Quiet hours still hold (a 2 a.m.
 *      report waits for morning — the chat nudge carries it meanwhile).
 *      Mute stays available: muting agent id 'kade-feedback-alert' in
 *      notify-prefs silences the pushes without touching code.
 *
 * Self-filings don't alert (she doesn't need a push about her own report).
 * FAIL-SOFT throughout: an alert hiccup must never break a filing.
 */

const OWNER_EMAIL = (process.env.KADE_OWNER_EMAIL || 'kademurdock@gmail.com').toLowerCase();

let _ownerId = null;
async function ownerUserId() {
  if (_ownerId) {
    return _ownerId;
  }
  const User = mongoose.models.User || mongoose.model('User');
  const u = await User.findOne({ email: OWNER_EMAIL }, { _id: 1 }).lean();
  _ownerId = u ? String(u._id) : null;
  return _ownerId;
}

async function reporterName(userId) {
  try {
    if (!userId) {
      return '';
    }
    const User = mongoose.models.User || mongoose.model('User');
    const u = await User.findOne({ _id: userId }, { name: 1, username: 1, email: 1 }).lean();
    return (u && (u.name || u.username || u.email)) || '';
  } catch (_) {
    return '';
  }
}

async function alertOwnerNewFeedback(doc, knownReporterName) {
  try {
    if (!doc) {
      return;
    }
    const owner = await ownerUserId();
    if (!owner) {
      logger.warn('[kadeOwnerAlerts] no owner account found — alert skipped');
      return;
    }
    if (doc.user && String(doc.user) === owner) {
      return; // her own filing — no self-alert
    }
    const cat = ['bug', 'feature', 'feedback'].includes(doc.category) ? doc.category : 'feedback';
    const who = knownReporterName || (await reporterName(doc.user)) || 'someone';
    const via =
      doc.agent && doc.agent !== 'Report a problem'
        ? ` through ${doc.agent}`
        : ' via Report a problem';
    const subject = doc.subject ? ` — "${doc.subject}"` : '';

    /* (a) in-chat nudge */
    try {
      const { KadePendingNudge } = require('~/models/kadeNudge');
      await KadePendingNudge.create({
        userId: owner,
        text: `New ${cat} report from ${who}${via}${subject}. It's waiting in the feedback dashboard.`,
        type: 'feedback',
        channel: 'chat',
      });
    } catch (nudgeErr) {
      logger.warn(`[kadeOwnerAlerts] chat nudge failed (non-fatal): ${nudgeErr.message}`);
    }

    /* (b) app push via bridge */
    try {
      const bridgeUrl = (
        process.env.BRIDGE_URL || 'https://kade-ai-bridge-production.up.railway.app'
      ).replace(/\/$/, '');
      const secret = process.env.BRIDGE_SECRET || process.env.NOTIFY_AGENT_SECRET || '';
      if (secret) {
        const r = await fetch(`${bridgeUrl}/notify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            secret,
            agentId: 'kade-feedback-alert',
            agentName: 'Bug Reports',
            title: `New ${cat} report`,
            body: `${who}${via}${subject}`.slice(0, 300),
            userId: owner,
            adminAlert: true,
          }),
        });
        const out = await r.json().catch(() => ({}));
        logger.info(
          `[kadeOwnerAlerts] push for report ${doc._id}: sent=${out.sent ?? '?'}${out.blocked ? ` blocked=${out.blocked}` : ''}`,
        );
      }
    } catch (pushErr) {
      logger.warn(`[kadeOwnerAlerts] push failed (non-fatal): ${pushErr.message}`);
    }
  } catch (err) {
    logger.warn(`[kadeOwnerAlerts] alert failed (non-fatal): ${err.message}`);
  }
}

module.exports = { alertOwnerNewFeedback };
