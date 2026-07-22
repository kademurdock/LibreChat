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
      { _id: 1, name: 1, username: 1, email: 1 },
    ).lean();
    if (u) {
      req.kadeOnBehalfOf = {
        id: String(u._id),
        name: u.name || u.username || '',
        email: u.email,
      };
      logger.info(
        `[kadeOnBehalfOf] admin ${req.user.id} voice-turn acting for ${u.email} (${req.kadeOnBehalfOf.id}) on Kade tools`,
      );
    } else {
      logger.warn(`[kadeOnBehalfOf] no user found for "${email}" — tools stay on the service account`);
    }
  } catch (e) {
    logger.warn(`[kadeOnBehalfOf] resolve failed (non-fatal): ${e.message}`);
  }
  return next();
}

module.exports = { resolveKadeOnBehalfOf };
