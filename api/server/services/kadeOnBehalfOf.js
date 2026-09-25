const mongoose = require('mongoose');
const { SystemRoles } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');

/**
 * KADE Session 23 — voice-lane identity threading.
 *
 * THE BUG THIS FIXES (found via Amber's logs): the app-voice/phone lane runs
 * headlessly — bridge -> inworld proxy -> /api/agents/chat — and the proxy
 * logs in as the SERVICE account (LIBRECHAT_USER = Kade's own admin login).
 * So every per-user Kade tool on a voice turn acted as Kade: Amber asked
 * Kiana to file her row bug (July 22, 17:26Z), Kiana really called
 * kade_feedback, and the report landed attributed to KADE. The resolved-
 * relay nudge then went to Kade, and Amber's "reopen it" would find nothing.
 *
 * THE FIX: the bridge already knows who's really on the line
 * (session.lcEmail — set by registration and by the web-voice ticket). It now
 * sends that as `userEmail`; the proxy forwards it as `kadeOnBehalfOf`; this
 * middleware resolves it to a real user and stashes {id, name, email} on
 * req.kadeOnBehalfOf, which handleTools uses as the ACTING user for the
 * per-user Kade tools (feedback, notify, message, transcribe).
 *
 * SECURITY: honored ONLY when the authenticated caller is an ADMIN (the
 * service account). Any non-admin sending the field gets it ignored + logged.
 * Fail-soft everywhere: a resolution hiccup must never break a voice turn —
 * worst case is the old behavior (tools act as the service account).
 *
 * Deliberately NOT rerouted: memory context, usage/billing, convo ownership —
 * those have their own per-user paths (the bridge composes call memories
 * itself; usage posts carry their own userId). This is tool attribution only.
 * (Sep 25 2026, Part 291: usage IS rerouted when KADE_VOICE_BILL_REAL=1, see
 * req.kadeBillTo below. Memory context and convo ownership still are not.)
 */
async function resolveKadeOnBehalfOf(req, _res, next) {
  try {
    const email = String((req.body || {}).kadeOnBehalfOf || '')
      .trim()
      .toLowerCase();
    if (!email) {
      return next();
    }
    if (!req.user || req.user.role !== SystemRoles.ADMIN) {
      logger.warn(
        `[kadeOnBehalfOf] non-admin user ${req.user?.id} sent kadeOnBehalfOf — ignored`,
      );
      return next();
    }
    const User = mongoose.models.User || mongoose.model('User');
    const u = await User.findOne(
      { email: { $in: [email, email.toLowerCase()] } },
      { _id: 1, name: 1, username: 1, email: 1, role: 1 },
    ).lean();
    if (u) {
      req.kadeOnBehalfOf = {
        id: String(u._id),
        name: u.name || u.username || '',
        email: u.email,
        role: u.role || SystemRoles.USER,
      };
      /* KADE Sep 25 2026 (Part 291), her words: "Yes, I do want double on voice." With the fork
       * switch KADE_VOICE_BILL_REAL=1 the real transaction for this turn is billed to the real
       * caller at the platform multiplier (client.js kadeUsageUser), and /usage-event zeroes the
       * bridge's per-call estimate so nobody pays twice. An admin calling (Kade herself) gets no
       * kadeBillTo and stays on her own exempt seat. Off by default: unset = today exactly.
       * Review F11: only a turn that says kadeBillCaller === true is billed. The proxy's call lane
       * (/librechat/ask-stream) sends it only when the bridge marks a caller-started call (inbound
       * phone, app and web voice); Kiana's friend texts, previews, briefs, outbound calls and every
       * other ask that names a person keep kadeOnBehalfOf for tools and stay on Kade's seat. */
      if (
        process.env.KADE_VOICE_BILL_REAL === '1' &&
        (req.body || {}).kadeBillCaller === true &&
        String(u.role || '').toUpperCase() !== SystemRoles.ADMIN
      ) {
        req.kadeBillTo = String(u._id);
      }
      logger.info(
        `[kadeOnBehalfOf] admin ${req.user.id} voice-turn acting for ${u.email} (${req.kadeOnBehalfOf.id}) on Kade tools${req.kadeBillTo ? '; usage billed to the caller' : ''}`,
      );
    } else {
      // Sep 24 2026: tools that read shared or private things (kade_library) and the
      // waiting-notes pickup check this and fail closed instead of acting as Kade.
      req.kadeOnBehalfOfUnresolved = true;
      logger.warn(`[kadeOnBehalfOf] no user found for "${email}" — tools stay on the service account`);
    }
  } catch (e) {
    if (req.user && req.user.role === SystemRoles.ADMIN) {
      req.kadeOnBehalfOfUnresolved = true;
    }
    logger.warn(`[kadeOnBehalfOf] resolve failed (non-fatal): ${e.message}`);
  }
  return next();
}

module.exports = { resolveKadeOnBehalfOf };
