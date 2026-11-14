'use strict';
/**
 * KADE Nov 14 2026 -- WHICH WRITING CALLS MAY GO TO CLAUDE ON KADE'S CREDIT.
 *
 * Her words, once character chat was on Claude: "Change the lyric desk etc to it too, whatever benefits from better
 * writing than Mimo." The gateway (reframe-proxy claude-route.js, THE WRITING LANES) is the one place that knows
 * about Claude. A writing call cannot be told from its prompt reliably, and most of them carry no audience note, so
 * this file tells the gateway two facts and nothing more:
 *
 *   x-kade-claude-lane  which writing lane the call is: lyric-desk (the Sound Booth song desk), booth-edit (the
 *                       booth's carry rewrite and Seed's cut-to-fit), persona-writer (the character builder) or
 *                       spotter-draft (the Spotter's personality brief). The fifth lane, speak-first (a character's
 *                       own message), rides a hidden run: services/kadeHiddenRun.js and endpoints/custom/initialize.ts.
 *   x-kade-adult: 1     the person is a verified adult, by the rule that gives a chat turn the website's
 *                       verified-adult note (Endpoints/agents/build.js isKadeAdult, after kadeAccountType.isChildLike):
 *                       an account typed adult, or the admin; never a child or a teen, never an untyped account.
 *
 * The gateway sends a marked call to Claude only when the person is marked adult and the lane is switched on there
 * (KADE_CLAUDE_CHAT=1, KADE_CLAUDE_LANES); otherwise the call goes exactly where it went before, and every failure on
 * Claude falls back to it. Headers never reach a model host. Fails closed: any trouble reading the account means no
 * adult mark. KADE_SEND_CLAUDE_LANE=0 sends neither header.
 *
 * No '~' requires at the top, so node --test loads this file (the account read is required lazily).
 */
const { audienceOf, isChildLike } = require('../services/kadeAccountType');

const LANES = Object.freeze(['lyric-desk', 'booth-edit', 'persona-writer', 'spotter-draft']);

/** build.js isKadeAdult, after the teen rule: typed adult, or the admin; never a child or teen; never untyped. */
function isVerifiedAdult(user) {
  if (!user || typeof user !== 'object' || isChildLike(user)) return false;
  return user.kadeAccountType !== 'child' && (user.kadeAccountType === 'adult' || user.role === 'ADMIN');
}

async function loadStoredAccount(id) {
  const { getUserById } = require('~/models');
  return getUserById(id, 'kadeAccountType role');
}

/**
 * Whether the person behind this request is a verified adult. The person is the one a chat turn's audience note
 * would be written for (kadeAccountType.audienceOf: the named caller on a voice turn, else the signed-in user). When
 * the request's user carries no account type, the stored one is read, as kadeSongAudience does. Never throws.
 * @returns {Promise<boolean>}
 */
async function claudeAdult(req, { loadUser = loadStoredAccount } = {}) {
  try {
    const { user } = audienceOf(req);
    if (!user) return false;
    if (user.kadeAccountType || user.role === 'ADMIN') return isVerifiedAdult(user);
    const id = user.id || user._id;
    if (!id) return false;
    const stored = await loadUser(String(id));
    return isVerifiedAdult({ ...user, kadeAccountType: stored && stored.kadeAccountType, role: (stored && stored.role) || user.role });
  } catch (_) {
    return false;
  }
}

/** The headers for one writing call: the lane, and the adult mark when `adult` is exactly true. */
function claudeLaneHeaders(lane, adult, env = process.env) {
  if (String((env && env.KADE_SEND_CLAUDE_LANE) ?? '').trim() === '0' || !LANES.includes(lane)) return {};
  return { 'x-kade-claude-lane': lane, ...(adult === true ? { 'x-kade-adult': '1' } : {}) };
}

module.exports = { LANES, isVerifiedAdult, claudeAdult, claudeLaneHeaders };
