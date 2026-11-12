'use strict';
/* Audit fix SEC-3 (Nov 12 2026): who may set up, resume or test a family check-in call.
 *
 * A check-in rings a real person, follows the topics its maker wrote, and sends that maker a
 * summary of what the person said. Kade's decision (Nov 12 2026): any grown-up account may still
 * ring any registered relative, as the Nudges page advertises. What this closes:
 *   - a child or teen account never sets one up, resumes one or fires a test call;
 *   - the character that places the call must be one this person may use
 *     (services/kadeAgentAccess.js, SEC-7), so nobody sends another person's private character;
 *   - on a voice turn the person asking is the person on the line, never the service seat (an
 *     admin), so a family member on a call is not treated as Kade.
 * A caller nobody could name gets nothing. Used by routes/kade.js (POST /wellness) and by
 * app/clients/tools/structured/KadePhoneCall.js, so the page and the tool cannot drift apart.
 *
 * A safety gate: no off switch. No '~' requires at load, so node --test loads it.
 */
const { isChildLike, audienceOf } = require('./kadeAccountType');

const NOT_KNOWN =
  'I could not tell whose account this is, so no check-in call was set up. Try again from the app.';
const GROWN_UP = 'Check-in calls are set up by a grown-up account.';
const NOT_YOUR_CHARACTER = 'That character is not one you can send.';

/** The account a plain signed-in request is from. */
function actorFromUser(user) {
  const id = String((user && (user.id || user._id)) || '');
  if (!id) return null;
  return {
    id,
    email: user.email,
    role: user.role,
    kadeAccountType: user.kadeAccountType,
    admin: String(user.role || '').toUpperCase() === 'ADMIN',
  };
}

/** The person a tool call is really from: on a voice turn the person on the line, never the
 * service seat (an admin). null when a voice turn names nobody known. */
function wellnessActor(req) {
  return actorFromUser(audienceOf(req).user);
}

/**
 * May this person create, change, resume or test a check-in?
 * @param {ReturnType<typeof actorFromUser>} actor
 * @param {{ agentId?: unknown }} ask  agentId: the character that will place the call.
 * @returns {Promise<{ ok: true } | { status: number, error: string }>}
 */
async function wellnessAllowed(actor, ask = {}, deps = {}) {
  if (!actor) return { status: 403, error: NOT_KNOWN };
  if (actor.admin) return { ok: true };
  if (isChildLike(actor)) return { status: 403, error: GROWN_UP };
  if (ask.agentId) {
    const canUseAgent = deps.canUseAgent || require('~/server/services/kadeAgentAccess').canUseAgent;
    if (!(await canUseAgent({ id: actor.id, role: actor.role }, String(ask.agentId)))) {
      return { status: 403, error: NOT_YOUR_CHARACTER };
    }
  }
  return { ok: true };
}

module.exports = {
  actorFromUser,
  wellnessActor,
  wellnessAllowed,
  GROWN_UP,
  NOT_KNOWN,
  NOT_YOUR_CHARACTER,
};
